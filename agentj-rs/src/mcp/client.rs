//! MCP client (rmcp). Connects to each configured server once at startup, lists its tools, and
//! exposes them as `ToolSpec`s (named `<server>__<tool>`) that merge into the agent's toolset. Tool
//! calls route back here. Stage 1: stdio (child process) + streamable-http with a static
//! `Authorization` header; OAuth is staged.

use crate::mcp::config::{McpServerConfig, Transport};
use crate::provider::ToolSpec;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

/// The outcome of connecting to one MCP server at startup, for a clean status display in the TUI.
pub struct McpStatus {
    pub name: String,
    /// `Ok(tool_count)` on success; `Err(reason)` on failure/timeout.
    pub outcome: Result<usize, String>,
}

/// Drain a child's stderr into a capped rolling buffer instead of letting it inherit (and spew all
/// over) agentj's terminal. The buffer is read back to surface the real error when a server fails.
fn drain_stderr(stderr: Option<tokio::process::ChildStderr>) -> Arc<Mutex<String>> {
    let buf = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let sink = buf.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut b = sink.lock().unwrap();
                b.push_str(&line);
                b.push('\n');
                let over = b.len().saturating_sub(4096);
                if over > 0 {
                    *b = b.split_off(over);
                }
            }
        });
    }
    buf
}

/// Pull the most informative line out of captured stderr: the last line mentioning an error, else the
/// last non-empty line (skipping the bare Node.js version footer).
fn error_hint(stderr: &str) -> Option<String> {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .rev()
        .find(|l| l.to_lowercase().contains("error"))
        .or_else(|| lines.iter().rev().find(|l| !l.starts_with("Node.js v")))
        .map(|l| l.chars().take(200).collect())
}

struct McpTool {
    full_name: String,
    short_name: String,
    description: String,
    input_schema: Value,
}

struct Server {
    service: RunningService<RoleClient, ()>,
    tools: Vec<McpTool>,
}

/// Connected MCP servers + a lookup from fully-qualified tool name to its server.
pub struct McpClients {
    servers: Vec<Server>,
    by_tool: HashMap<String, usize>,
}

fn render_result(res: rmcp::model::CallToolResult) -> String {
    let text = res
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n");
    if res.is_error.unwrap_or(false) {
        format!(
            "error: {}",
            if text.is_empty() {
                "tool reported an error".to_string()
            } else {
                text
            }
        )
    } else if !text.is_empty() {
        text
    } else if let Some(sc) = res.structured_content {
        sc.to_string()
    } else {
        "(no output)".to_string()
    }
}

async fn connect_one(cfg: &McpServerConfig) -> anyhow::Result<Server> {
    let service = match cfg.transport {
        Transport::Stdio => {
            let mut command = tokio::process::Command::new(cfg.command.clone().unwrap_or_default());
            command.args(&cfg.args);
            for (k, v) in &cfg.env {
                command.env(k, v);
            }
            // Capture the child's stderr rather than inheriting agentj's terminal — otherwise a
            // server's npm warnings, auth prompts, and crash traces spew over the screen before the
            // TUI even opens.
            let (transport, stderr) = TokioChildProcess::builder(command)
                .stderr(Stdio::piped())
                .spawn()?;
            let errbuf = drain_stderr(stderr);
            match ().serve(transport).await {
                Ok(s) => s,
                Err(e) => {
                    // The transport error ("channel closed") is usually opaque; the real reason is in
                    // the captured stderr (e.g. "RPA_FILES_S3_BUCKET not configured").
                    let captured = errbuf.lock().unwrap().clone();
                    match error_hint(&captured) {
                        Some(hint) => anyhow::bail!("{hint}"),
                        None => return Err(e.into()),
                    }
                }
            }
        }
        Transport::Http | Transport::Sse => {
            // Stage 1: plain streamable-http. Static `Authorization` headers + OAuth are staged (a
            // server needing either just surfaces as a connect notice for now).
            let url = cfg.url.clone().unwrap_or_default();
            let transport = StreamableHttpClientTransport::from_uri(url);
            ().serve(transport).await?
        }
    };

    let raw = service.list_all_tools().await?;
    let tools = raw
        .into_iter()
        .map(|t| McpTool {
            full_name: format!("{}__{}", cfg.name, t.name),
            short_name: t.name.to_string(),
            description: t.description.map(|d| d.to_string()).unwrap_or_default(),
            input_schema: serde_json::to_value(&*t.input_schema)
                .unwrap_or_else(|_| json!({ "type": "object" })),
        })
        .collect();
    Ok(Server { service, tools })
}

/// Connect to every configured server, each bounded by a timeout so one hung server can't freeze
/// startup. Returns the clients plus one-line notices for failures/timeouts.
pub async fn connect_all(configs: &[McpServerConfig]) -> (McpClients, Vec<McpStatus>) {
    use std::time::Duration;
    let mut servers = Vec::new();
    let mut by_tool = HashMap::new();
    let mut statuses = Vec::new();
    for cfg in configs {
        let timeout = cfg
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(Duration::from_secs(30));
        let outcome = match tokio::time::timeout(timeout, connect_one(cfg)).await {
            Ok(Ok(server)) => {
                let idx = servers.len();
                for t in &server.tools {
                    by_tool.insert(t.full_name.clone(), idx);
                }
                let n = server.tools.len();
                servers.push(server);
                Ok(n)
            }
            Ok(Err(e)) => Err(format!("{e}")),
            Err(_) => Err(format!("timed out connecting (>{}s)", timeout.as_secs())),
        };
        statuses.push(McpStatus { name: cfg.name.clone(), outcome });
    }
    (McpClients { servers, by_tool }, statuses)
}

impl McpClients {
    /// Tool specs advertised to the model (each `<server>__<tool>`).
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.servers
            .iter()
            .flat_map(|s| {
                s.tools.iter().map(|t| ToolSpec {
                    name: t.full_name.clone(),
                    description: t.description.clone(),
                    parameters: t.input_schema.clone(),
                })
            })
            .collect()
    }

    pub fn has_tool(&self, name: &str) -> bool {
        self.by_tool.contains_key(name)
    }

    pub fn tool_count(&self) -> usize {
        self.by_tool.len()
    }

    /// Call an MCP tool by its fully-qualified name, returning flattened text and a structural
    /// success flag. `ok` comes from the rmcp result's `is_error` (false on a transport error), so
    /// callers don't have to re-sniff it from the rendered string.
    pub async fn call(&self, name: &str, args: &Value) -> (String, bool) {
        let Some(&idx) = self.by_tool.get(name) else {
            return (format!("error: unknown MCP tool `{name}`"), false);
        };
        let server = &self.servers[idx];
        let short = server
            .tools
            .iter()
            .find(|t| t.full_name == name)
            .map(|t| t.short_name.clone())
            .unwrap_or_default();
        let mut params = CallToolRequestParams::new(short);
        if let Some(obj) = args.as_object() {
            params = params.with_arguments(obj.clone());
        }
        match server.service.call_tool(params).await {
            Ok(res) => {
                let ok = !res.is_error.unwrap_or(false);
                (render_result(res), ok)
            }
            Err(e) => (format!("error: {e}"), false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::error_hint;

    #[test]
    fn error_hint_picks_the_error_line_over_the_node_footer() {
        let stderr = "npm warn config\nError: RPA_FILES_S3_BUCKET not configured.\n    at getRpaFilesBucket\n\nNode.js v24.14.1\n";
        assert_eq!(error_hint(stderr).as_deref(), Some("Error: RPA_FILES_S3_BUCKET not configured."));
        // no "error" line → last non-footer line
        assert_eq!(error_hint("just a warning\nNode.js v24\n").as_deref(), Some("just a warning"));
        assert_eq!(error_hint("   \n  \n"), None);
    }
}
