//! The agent's tools: files, search, shell, background jobs, browser checks, and MCP passthrough.
//! Confined to `root` via `paths::safe_resolve`; auto-permission; tools return a string, never
//! error out of the call.
//!
//! This file is the registry: [`ToolOutcome`], the [`Tools`] state bundle, and the dispatch in
//! [`Tools::call`]. Each concept lives in its own submodule:
//!  - `files` — read/write/edit/list, with post-edit echoes
//!  - `search` — glob and grep
//!  - `shell` — `bash` and background-job control
//!  - `webcheck` — headless-browser verification
//!  - `paths` — repo-root confinement (`safe_resolve`)
//!  - `stamps` — the read-stamp staleness guard (`ReadStamps`)
//!  - `spec` — the schemas advertised to the model ([`tool_specs`])

mod files;
mod paths;
mod search;
mod shell;
mod spec;
mod stamps;
mod webcheck;

#[cfg(test)]
mod tests;

pub use spec::tool_specs;

use crate::jobs::JobManager;
use crate::mcp::client::McpClients;
use crate::provider::ToolSpec;
use serde_json::Value;
use stamps::ReadStamps;
use std::path::PathBuf;
use std::sync::Arc;

/// A tool result. `text` is what the model sees (tools never error out of a call, per convention);
/// `ok` is a structural success flag the UI uses to mark failed calls, decided at the source instead
/// of re-sniffed from the string.
pub struct ToolOutcome {
    pub text: String,
    pub ok: bool,
}

impl ToolOutcome {
    pub(crate) fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ok: true,
        }
    }
    pub(crate) fn err(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ok: false,
        }
    }
}

/// Everything the tools need to run: the confinement root, the background-job manager, connected
/// MCP servers, and the staleness guard for edits.
pub struct Tools {
    pub root: PathBuf,
    pub jobs: Arc<JobManager>,
    mcp: Option<Arc<McpClients>>,
    stamps: ReadStamps,
}

/// The value of `args[key]` when it's a string — the common shape of tool arguments.
fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

impl Tools {
    pub fn new(root: PathBuf, jobs: Arc<JobManager>, mcp: Option<Arc<McpClients>>) -> Self {
        Self {
            root,
            jobs,
            mcp,
            stamps: ReadStamps::new(),
        }
    }

    /// Tool specs contributed by connected MCP servers (each `<server>__<tool>`).
    pub fn mcp_specs(&self) -> Vec<ToolSpec> {
        self.mcp.as_ref().map(|m| m.specs()).unwrap_or_default()
    }

    /// Disconnect the MCP clients (used before swapping in a freshly authorized set).
    pub fn shutdown_mcp(&self) {
        if let Some(mcp) = &self.mcp {
            mcp.shutdown();
        }
    }

    fn root_str(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    /// Dispatch one tool call by name. Built-ins first; anything else is tried against the
    /// connected MCP servers.
    pub async fn call(&self, name: &str, args: &Value) -> ToolOutcome {
        match name {
            "read_file" => self.read_file(args),
            "write_file" => self.write_file(args),
            "edit_file" => self.edit_file(args),
            "edit_lines" => self.edit_lines(args),
            "list_dir" => self.list_dir(args),
            "glob" => self.glob(args).await,
            "grep" => self.grep(args).await,
            "bash" => self.bash(args).await,
            "web_check" => webcheck::web_check(&self.root, args).await,
            "job_start" => self.job_start(args).await,
            "job_check" => ToolOutcome::ok(
                self.jobs
                    .check(args.get("id").and_then(|v| v.as_u64()))
                    .await,
            ),
            "job_stop" => match args.get("id").and_then(|v| v.as_u64()) {
                Some(id) => ToolOutcome::ok(self.jobs.stop(id).await),
                None => ToolOutcome::err("error: job_stop needs an id"),
            },
            "mcp_find_tools" => match &self.mcp {
                Some(mcp) => ToolOutcome::ok(
                    mcp.find_tools(args.get("query").and_then(|v| v.as_str()).unwrap_or_default()),
                ),
                None => ToolOutcome::err("error: no MCP servers connected"),
            },
            other => match &self.mcp {
                Some(mcp) if mcp.has_tool(other) => {
                    let (text, ok) = mcp.call(other, args).await;
                    ToolOutcome { text, ok }
                }
                _ => ToolOutcome::err(format!("error: unknown tool `{other}`")),
            },
        }
    }
}
