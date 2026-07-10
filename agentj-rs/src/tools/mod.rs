//! The agent's tools: files, search, shell, background jobs, browser checks, and MCP passthrough.
//! Confined to `root` via `paths::safe_resolve`; auto-permission; tools return a string, never
//! error out of the call.
//!
//! This file is the registry: [`ToolOutcome`], the [`Tools`] state bundle, and the dispatch in
//! [`Tools::call`]. Each concept lives in its own submodule:
//!  - `files` — read/write/edit/list, with post-edit echoes
//!  - `search` — glob and grep
//!  - `shell` — `bash` and background-job control
//!  - `paths` — repo-root confinement (`safe_resolve`)
//!  - `stamps` — the read-stamp staleness guard (`ReadStamps`)
//!  - `spec` — the schemas advertised to the model ([`tool_specs`])

mod files;
mod paths;
mod search;
mod shell;
mod spec;
mod stamps;

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
    /// The interactive session's artifact store, when there is one (the primary TUI). `None` for
    /// headless `--once` runs — they don't persist artifacts, so `save_artifact` /
    /// `read_artifact` aren't advertised to them.
    pub session: Option<Arc<crate::session::Session>>,
    /// The subagent type this tool set is scoped to (`None` = the primary/PRIME loop, full tools).
    /// Built-in tools the type disallows are neither advertised nor dispatchable.
    pub agent_type: Option<crate::agent::AgentType>,
}

/// Every built-in tool name — used to tell a disallowed built-in (blocked for a scoped subagent)
/// from an MCP tool (always passes through).
const BUILTINS: &[&str] = &[
    "read_file", "write_file", "edit_file", "edit_lines", "list_dir", "glob", "grep", "bash",
    "save_artifact", "edit_artifact", "read_artifact", "job_start", "job_check",
    "job_stop", "mcp_find_tools", "run_subagents",
];

/// The value of `args[key]` when it's a string — the common shape of tool arguments.
fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

impl Tools {
    #[cfg(test)]
    pub fn new(
        root: PathBuf,
        jobs: Arc<JobManager>,
        mcp: Option<Arc<McpClients>>,
    ) -> Self {
        Self::with_session(root, jobs, mcp, None)
    }

    pub fn with_session(
        root: PathBuf,
        jobs: Arc<JobManager>,
        mcp: Option<Arc<McpClients>>,
        session: Option<Arc<crate::session::Session>>,
    ) -> Self {
        Self {
            root,
            jobs,
            mcp,
            stamps: ReadStamps::new(),
            session,
            agent_type: None,
        }
    }

    /// A copy of these tools scoped to a subagent `type`: shares the root/jobs/MCP handles, drops the
    /// artifact store (subagents don't persist artifacts) and gets fresh read-stamps, and records the
    /// type so its tool allowlist is enforced.
    pub fn scoped_to(&self, agent_type: crate::agent::AgentType) -> Tools {
        Tools {
            root: self.root.clone(),
            jobs: self.jobs.clone(),
            mcp: self.mcp.clone(),
            stamps: ReadStamps::new(),
            session: None,
            agent_type: Some(agent_type),
        }
    }

    /// Whether an interactive artifact store is attached (gates the artifact tools' advertisement).
    pub fn has_session(&self) -> bool {
        self.session.is_some()
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

    /// `save_artifact` — persist a named session artifact (the model's `plan`/`todos`, a decision
    /// log, …) to the global session store, OUTSIDE the repo. Only reachable when a session is
    /// attached (its spec is gated the same way).
    fn save_artifact(&self, args: &Value) -> ToolOutcome {
        let (Some(name), Some(content)) = (arg_str(args, "name"), arg_str(args, "content")) else {
            return ToolOutcome::err("error: save_artifact needs a name and content");
        };
        let Some(session) = &self.session else {
            return ToolOutcome::err("error: no session artifact store attached");
        };
        match session.save_artifact(name, content) {
            Ok(_) => ToolOutcome::ok(format!(
                "saved artifact `{name}` ({} bytes) to this session — it persists across resume \
                 and is not written into the repo",
                content.len()
            )),
            Err(e) => ToolOutcome::err(format!("error: could not save artifact `{name}`: {e}")),
        }
    }

    /// `edit_artifact` — surgical in-place edits to an existing artifact (cheap incremental updates,
    /// e.g. flipping one `todos` checkbox instead of rewriting the list).
    fn edit_artifact(&self, args: &Value) -> ToolOutcome {
        let Some(name) = arg_str(args, "name") else {
            return ToolOutcome::err("error: edit_artifact needs a name");
        };
        let Some(session) = &self.session else {
            return ToolOutcome::err("error: no session artifact store attached");
        };
        let edits: Vec<(String, String)> = args
            .get("edits")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| {
                        let old = e.get("old_string")?.as_str()?.to_string();
                        let new = e.get("new_string")?.as_str()?.to_string();
                        Some((old, new))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if edits.is_empty() {
            return ToolOutcome::err(
                "error: edit_artifact needs `edits`: [{old_string, new_string}, …]",
            );
        }
        match session.edit_artifact(name, &edits) {
            Ok(content) => {
                let shown: String = content.chars().take(2000).collect();
                ToolOutcome::ok(format!(
                    "edited artifact `{name}` ({} edit(s)) — now {} bytes:\n{shown}",
                    edits.len(),
                    content.len()
                ))
            }
            Err(e) => ToolOutcome::err(format!("error: {e}")),
        }
    }

    /// `read_artifact` — read a named session artifact back.
    fn read_artifact(&self, args: &Value) -> ToolOutcome {
        let Some(name) = arg_str(args, "name") else {
            return ToolOutcome::err("error: read_artifact needs a name");
        };
        let Some(session) = &self.session else {
            return ToolOutcome::err("error: no session artifact store attached");
        };
        match session.read_artifact(name) {
            Some(content) => ToolOutcome::ok(content),
            None => ToolOutcome::err(format!("no artifact `{name}` in this session yet")),
        }
    }

    /// Dispatch one tool call by name. Built-ins first; anything else is tried against the
    /// connected MCP servers.
    pub async fn call(&self, name: &str, args: &Value) -> ToolOutcome {
        // A type-scoped subagent may only call the built-ins its type allows (MCP tools pass
        // through). The specs already hide these, but enforce at dispatch too — belt and braces.
        if let Some(t) = self.agent_type {
            if BUILTINS.contains(&name) && !t.allows(name) {
                return ToolOutcome::err(format!(
                    "error: `{name}` is not available to a {} subagent",
                    t.as_str()
                ));
            }
        }
        match name {
            "read_file" => self.read_file(args),
            "write_file" => self.write_file(args),
            "edit_file" => self.edit_file(args),
            "edit_lines" => self.edit_lines(args),
            "list_dir" => self.list_dir(args),
            "glob" => self.glob(args).await,
            "grep" => self.grep(args).await,
            "bash" => self.bash(args).await,
            "save_artifact" => self.save_artifact(args),
            "edit_artifact" => self.edit_artifact(args),
            "read_artifact" => self.read_artifact(args),
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
