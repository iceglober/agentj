//! MCP client (rmcp). Connects to each configured server once at startup, lists its tools, and
//! exposes them as `ToolSpec`s (named `<server>__<tool>`) that merge into the agent's toolset. Tool
//! calls route back here. Stage 1: stdio (child process) + streamable-http with a static
//! `Authorization` header; OAuth is staged.

use crate::mcp::config::{McpServerConfig, Transport};
use crate::provider::ToolSpec;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

/// The outcome of connecting to one MCP server at startup, for a clean status display in the TUI.
pub struct McpStatus {
    pub name: String,
    pub outcome: McpOutcome,
}

pub enum McpOutcome {
    /// Connected; carries the tool count.
    Ok(usize),
    /// An OAuth server with no cached grant on this machine. Deliberate, never ambient: startup
    /// doesn't block or open a browser — the user authorizes once via `/mcp login <name>`.
    NeedsAuth,
    Err(String),
}

/// Sentinel error text from `connect_one` meaning "this server wants OAuth and has no usable grant";
/// `connect_all` turns it into `McpOutcome::NeedsAuth`.
const NEEDS_AUTH_MARKER: &str = "__needs_auth__";

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
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
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

/// Metadata for every connected MCP tool, independent of the live connections — this is what decides
/// WHAT the model sees. Small sets are advertised eagerly; big sets advertise one `mcp_find_tools`
/// meta-tool, and only tools the model has looked up (activated) ship their full schemas. That keeps
/// dozens of verbose schemas (e.g. Linear's 50) out of every prompt.
pub struct McpCatalog {
    entries: Vec<CatalogEntry>,
    activated: Mutex<std::collections::HashSet<String>>,
    /// Small toolsets skip the meta-tool indirection entirely.
    eager: bool,
}

#[derive(Clone)]
struct CatalogEntry {
    full_name: String,
    server: String,
    description: String,
    input_schema: Value,
}

/// Advertised toolset budget (~tokens, chars/4). Above it, the catalog goes lazy.
const EAGER_BUDGET_TOKENS: usize = 4_000;
/// Most matches a single find call will activate.
const FIND_ACTIVATE_CAP: usize = 12;

impl McpCatalog {
    pub fn new(entries: Vec<(String, String, String, Value)>) -> Self {
        let entries: Vec<CatalogEntry> = entries
            .into_iter()
            .map(
                |(full_name, server, description, input_schema)| CatalogEntry {
                    full_name,
                    server,
                    description,
                    input_schema,
                },
            )
            .collect();
        let est_tokens: usize = entries
            .iter()
            .map(|e| {
                (e.full_name.len()
                    + e.description.len().min(250)
                    + serde_json::to_string(&e.input_schema)
                        .map(|s| s.len())
                        .unwrap_or(0))
                    / 4
            })
            .sum();
        Self {
            entries,
            activated: Mutex::new(std::collections::HashSet::new()),
            eager: est_tokens <= EAGER_BUDGET_TOKENS,
        }
    }

    /// The tool specs to advertise right now: everything (slimmed) when eager; when lazy, the
    /// meta-tool plus only the activated tools' full (slimmed) schemas.
    pub fn specs(&self) -> Vec<ToolSpec> {
        let mut out = Vec::new();
        if self.eager {
            out.extend(self.entries.iter().map(slim_spec));
            return out;
        }
        out.push(self.finder_spec());
        let activated = self.activated.lock().unwrap();
        out.extend(
            self.entries
                .iter()
                .filter(|e| activated.contains(&e.full_name))
                .map(slim_spec),
        );
        out
    }

    fn finder_spec(&self) -> ToolSpec {
        // Per-server counts so the model knows what's discoverable.
        let mut counts: Vec<(String, usize)> = Vec::new();
        for e in &self.entries {
            match counts.iter_mut().find(|(s, _)| s == &e.server) {
                Some((_, n)) => *n += 1,
                None => counts.push((e.server.clone(), 1)),
            }
        }
        let summary = counts
            .iter()
            .map(|(s, n)| format!("{s} ({n})"))
            .collect::<Vec<_>>()
            .join(", ");
        ToolSpec {
            name: "mcp_find_tools".to_string(),
            description: format!(
                "Find MCP tools by capability. {} tools are connected but not listed here: {summary}. \
                 Search by keywords (e.g. \"create issue\", \"list comments\", server name); matching \
                 tools BECOME CALLABLE with their full schemas from your next step. Call this before \
                 assuming a capability is missing.",
                self.entries.len()
            ),
            parameters: json!({
                "type": "object",
                "properties": { "query": { "type": "string", "description": "keywords or a server name; empty lists the servers" } },
                "required": ["query"]
            }),
        }
    }

    /// Search the catalog; matches are ACTIVATED (their schemas advertise from the next model call)
    /// and rendered as a list. An empty query returns the per-server summary.
    pub fn find_tools(&self, query: &str) -> String {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|t| t.to_lowercase())
            .filter(|t| t.len() > 1)
            .collect();
        if terms.is_empty() {
            let mut lines = vec!["connected MCP servers:".to_string()];
            let mut seen = Vec::new();
            for e in &self.entries {
                if !seen.contains(&e.server) {
                    let n = self.entries.iter().filter(|x| x.server == e.server).count();
                    lines.push(format!("  {} — {n} tools", e.server));
                    seen.push(e.server.clone());
                }
            }
            lines.push("search with keywords to activate specific tools".to_string());
            return lines.join("\n");
        }
        let mut scored: Vec<(usize, &CatalogEntry)> = self
            .entries
            .iter()
            .filter_map(|e| {
                let hay = format!("{} {}", e.full_name, e.description).to_lowercase();
                let hits = terms.iter().filter(|t| hay.contains(t.as_str())).count();
                (hits > 0).then_some((hits, e))
            })
            .collect();
        if scored.is_empty() {
            return format!("no MCP tools match {query:?} — try broader keywords or a server name");
        }
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.full_name.cmp(&b.1.full_name)));
        let take = scored.len().min(FIND_ACTIVATE_CAP);
        let mut activated = self.activated.lock().unwrap();
        let mut lines = vec![format!(
            "{} match(es){} — now callable:",
            scored.len(),
            if scored.len() > take {
                format!(" (top {take} activated)")
            } else {
                String::new()
            }
        )];
        for (_, e) in scored.iter().take(take) {
            activated.insert(e.full_name.clone());
            lines.push(format!(
                "  {} — {}",
                e.full_name,
                clip_chars(&e.description, 140)
            ));
        }
        lines.join("\n")
    }

    #[cfg(test)]
    fn is_activated(&self, name: &str) -> bool {
        self.activated.lock().unwrap().contains(name)
    }
}

/// A slimmed, prompt-ready spec: description capped, schema stripped of prose bloat. Types, enums,
/// and required fields survive — the model keeps what it needs to call correctly.
fn slim_spec(e: &CatalogEntry) -> ToolSpec {
    let mut schema = e.input_schema.clone();
    slim_schema(&mut schema);
    ToolSpec {
        name: e.full_name.clone(),
        description: clip_chars(&e.description, 250),
        parameters: schema,
    }
}

/// Walk a JSON schema: truncate property descriptions, drop examples/titles/$comment.
fn slim_schema(v: &mut Value) {
    match v {
        Value::Object(map) => {
            map.remove("examples");
            map.remove("title");
            map.remove("$comment");
            if let Some(Value::String(d)) = map.get_mut("description") {
                if d.chars().count() > 120 {
                    *d = clip_chars(d, 120);
                }
            }
            for (_, child) in map.iter_mut() {
                slim_schema(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                slim_schema(item);
            }
        }
        _ => {}
    }
}

fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

struct Server {
    service: RunningService<RoleClient, ()>,
    tools: Vec<McpTool>,
    /// PID of a stdio server's child (group leader), so its whole `npx → npm → node` tree can be
    /// killed on shutdown. `None` for http/sse.
    pid: Option<u32>,
}

/// Connected MCP servers + a lookup from fully-qualified tool name to its server.
pub struct McpClients {
    servers: Vec<Server>,
    by_tool: HashMap<String, usize>,
    catalog: McpCatalog,
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

/// SIGKILL a child's whole process group (children spawn with `process_group(0)`).
fn kill_group(pid: u32) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    let _ = kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL);
}

/// `spawned` is set to the child pid as soon as it exists, so the caller can kill the process GROUP
/// even when this future fails or is cancelled by a timeout — a cancelled connect otherwise reaps
/// only the direct child (rmcp's drop) and orphans `npm → node` descendants, which keep holding
/// ports (the mcp-remote EADDRINUSE zombie).
async fn connect_one(
    cfg: &McpServerConfig,
    spawned: &Mutex<Option<u32>>,
) -> anyhow::Result<Server> {
    let (service, pid) = match cfg.transport {
        Transport::Stdio => {
            let mut command = tokio::process::Command::new(cfg.command.clone().unwrap_or_default());
            command.args(&cfg.args);
            for (k, v) in &cfg.env {
                command.env(k, v);
            }
            // Own process group so we can kill the whole `npx → npm → node` tree on shutdown instead
            // of orphaning children that keep holding ports (the mcp-remote EADDRINUSE zombie).
            command.process_group(0);
            // Capture the child's stderr rather than inheriting agentj's terminal — otherwise a
            // server's npm warnings, auth prompts, and crash traces spew over the screen before the
            // TUI even opens.
            let (transport, stderr) = TokioChildProcess::builder(command)
                .stderr(Stdio::piped())
                .spawn()?;
            let pid = transport.id();
            *spawned.lock().unwrap() = pid;
            let errbuf = drain_stderr(stderr);
            let service = match ().serve(transport).await {
                Ok(s) => s,
                Err(e) => {
                    // The transport error ("channel closed") is usually opaque; the real reason is in
                    // the captured stderr (e.g. "RPA_FILES_S3_BUCKET not configured"). The drain task
                    // races a fast crash, so give it a moment to consume the child's dying words
                    // before reading — otherwise we show the opaque error even though the real one
                    // arrived milliseconds later.
                    let mut captured = String::new();
                    for _ in 0..10 {
                        captured = errbuf.lock().unwrap().clone();
                        if !captured.trim().is_empty() {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    match error_hint(&captured) {
                        Some(hint) => anyhow::bail!("{hint}"),
                        None => return Err(e.into()),
                    }
                }
            };
            (service, pid)
        }
        Transport::Http | Transport::Sse => {
            let url = cfg.url.clone().unwrap_or_default();
            let mut tcfg = StreamableHttpClientTransportConfig::with_uri(url.clone());
            // Static headers from the config are sent on every request; `Authorization` rides the
            // dedicated auth_header slot.
            for (k, v) in &cfg.headers {
                if k.eq_ignore_ascii_case("authorization") {
                    tcfg.auth_header = Some(v.clone());
                } else if let (Ok(name), Ok(value)) = (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(v),
                ) {
                    tcfg.custom_headers.insert(name, value);
                }
            }
            let has_static = crate::mcp::config::has_static_auth(cfg);
            if !has_static && crate::mcp::oauth::has_cached_credentials(&url) {
                // This machine holds a grant for the server: connect through the OAuth client, which
                // attaches (and refreshes) the token itself.
                match crate::mcp::oauth::cached_auth_client(&url).await {
                    Some(auth) => {
                        let transport = StreamableHttpClientTransport::with_client(auth, tcfg);
                        (().serve(transport).await?, None)
                    }
                    // A grant exists but can't be used (revoked / metadata gone) → re-authorize.
                    None => anyhow::bail!(NEEDS_AUTH_MARKER),
                }
            } else {
                let transport =
                    StreamableHttpClientTransport::with_client(reqwest::Client::default(), tcfg);
                match ().serve(transport).await {
                    Ok(s) => (s, None),
                    // A bare http server that refuses the handshake and carries no static auth is in
                    // all likelihood an OAuth server without a grant — surface "authorize me", never
                    // auto-open a browser.
                    Err(_) if !has_static => anyhow::bail!(NEEDS_AUTH_MARKER),
                    Err(e) => return Err(e.into()),
                }
            }
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
    Ok(Server {
        service,
        tools,
        pid,
    })
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
        let spawned = Mutex::new(None);
        let outcome = match tokio::time::timeout(timeout, connect_one(cfg, &spawned)).await {
            Ok(Ok(server)) => {
                let idx = servers.len();
                for t in &server.tools {
                    by_tool.insert(t.full_name.clone(), idx);
                }
                let n = server.tools.len();
                servers.push(server);
                McpOutcome::Ok(n)
            }
            // Failed or timed out: the child (if any) is useless now — kill its whole tree so it
            // can't linger holding ports. Successful servers are killed later by `shutdown()`.
            Ok(Err(e)) if e.to_string() == NEEDS_AUTH_MARKER => McpOutcome::NeedsAuth,
            Ok(Err(e)) => {
                if let Some(pid) = *spawned.lock().unwrap() {
                    kill_group(pid);
                }
                McpOutcome::Err(format!("{e}"))
            }
            Err(_) => {
                if let Some(pid) = *spawned.lock().unwrap() {
                    kill_group(pid);
                }
                McpOutcome::Err(format!("timed out connecting (>{}s)", timeout.as_secs()))
            }
        };
        statuses.push(McpStatus {
            name: cfg.name.clone(),
            outcome,
        });
    }
    let catalog = McpCatalog::new(
        servers
            .iter()
            .flat_map(|srv| &srv.tools)
            .map(|t| {
                // full_name is `{server}__{tool}` — recover the server for the catalog summary.
                let server = t
                    .full_name
                    .split("__")
                    .next()
                    .unwrap_or_default()
                    .to_string();
                (
                    t.full_name.clone(),
                    server,
                    t.description.clone(),
                    t.input_schema.clone(),
                )
            })
            .collect(),
    );
    (
        McpClients {
            servers,
            by_tool,
            catalog,
        },
        statuses,
    )
}

impl McpClients {
    /// Kill every stdio server's process GROUP. Called on every agentj exit path so `npx → npm →
    /// node` trees never orphan — a leaked mcp-remote keeps holding its OAuth callback port, and the
    /// next launch dies with EADDRINUSE. (rmcp's drop only reaps the direct child, not descendants.)
    pub fn shutdown(&self) {
        for s in &self.servers {
            if let Some(pid) = s.pid {
                kill_group(pid);
            }
        }
    }

    /// Tool specs advertised to the model right now: eager (all, slimmed) for small toolsets; lazy
    /// (`mcp_find_tools` + activated schemas) for big ones. See `McpCatalog`.
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.catalog.specs()
    }

    /// Search the catalog and activate matches (the `mcp_find_tools` meta-tool).
    pub fn find_tools(&self, query: &str) -> String {
        self.catalog.find_tools(query)
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
            Err(e) => {
                let m = e.to_string();
                // A dead transport is opaque as raw rmcp text ("Send message error … worker …").
                // Name the server and explain, so it's actionable rather than cryptic.
                let dead = m.contains("transport") || m.contains("worker") || m.contains("closed");
                let text = if dead {
                    format!(
                        "error: MCP `{name}` is disconnected — its transport died (the server crashed, \
                         the connection dropped, or auth expired/was never established, e.g. an OAuth \
                         server used over plain http instead of via `mcp-remote`). Restart agentj to \
                         reconnect. [{m}]"
                    )
                } else {
                    format!("error: {e}")
                };
                (text, false)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_hint_picks_the_error_line_over_the_node_footer() {
        let stderr = "npm warn config\nError: RPA_FILES_S3_BUCKET not configured.\n    at getRpaFilesBucket\n\nNode.js v24.14.1\n";
        assert_eq!(
            error_hint(stderr).as_deref(),
            Some("Error: RPA_FILES_S3_BUCKET not configured.")
        );
        // no "error" line → last non-footer line
        assert_eq!(
            error_hint("just a warning\nNode.js v24\n").as_deref(),
            Some("just a warning")
        );
        assert_eq!(error_hint("   \n  \n"), None);
    }

    fn entry(server: &str, tool: &str, desc: &str) -> (String, String, String, Value) {
        (
            format!("{server}__{tool}"),
            server.to_string(),
            desc.to_string(),
            json!({ "type": "object", "properties": { "id": { "type": "string", "description": "the id" } } }),
        )
    }

    #[test]
    fn small_catalogs_stay_eager_big_ones_go_lazy() {
        let small = McpCatalog::new(vec![entry("db", "query", "run sql")]);
        assert!(small.eager);
        let specs = small.specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].name, "db__query");

        // 60 tools with fat descriptions blow the eager budget.
        let big = McpCatalog::new(
            (0..60)
                .map(|i| entry("linear", &format!("tool_{i}"), &"x".repeat(1200)))
                .collect(),
        );
        assert!(!big.eager);
        let specs = big.specs();
        assert_eq!(specs.len(), 1, "only the meta-tool advertises");
        assert_eq!(specs[0].name, "mcp_find_tools");
        assert!(
            specs[0].description.contains("linear (60)"),
            "{}",
            specs[0].description
        );
    }

    #[test]
    fn find_activates_matches_and_their_schemas_advertise() {
        let mut entries: Vec<_> = (0..60)
            .map(|i| entry("linear", &format!("tool_{i}"), &"x".repeat(1200)))
            .collect();
        entries.push(entry(
            "linear",
            "create_issue",
            "Create a new Linear issue in a team",
        ));
        let cat = McpCatalog::new(entries);
        assert!(!cat.eager);

        let out = cat.find_tools("create issue");
        assert!(out.contains("linear__create_issue"), "{out}");
        assert!(cat.is_activated("linear__create_issue"));

        let specs = cat.specs();
        assert!(
            specs.iter().any(|s| s.name == "linear__create_issue"),
            "activated schema advertises"
        );
        assert!(
            specs.iter().any(|s| s.name == "mcp_find_tools"),
            "meta-tool stays"
        );

        // No match → helpful message, nothing activated.
        let miss = cat.find_tools("zzzznope");
        assert!(miss.contains("no MCP tools match"));
        // Empty query → server summary.
        assert!(cat.find_tools("").contains("linear — 61 tools"));
    }

    #[test]
    fn slimming_caps_descriptions_and_strips_schema_bloat() {
        let e = CatalogEntry {
            full_name: "s__t".into(),
            server: "s".into(),
            description: "d".repeat(400),
            input_schema: json!({
                "type": "object",
                "title": "Fancy",
                "examples": [{"id": "x"}],
                "properties": { "id": { "type": "string", "description": "p".repeat(300) } }
            }),
        };
        let spec = slim_spec(&e);
        assert!(spec.description.chars().count() <= 250);
        assert!(spec.parameters.get("title").is_none());
        assert!(spec.parameters.get("examples").is_none());
        let pdesc = spec.parameters["properties"]["id"]["description"]
            .as_str()
            .unwrap();
        assert!(pdesc.chars().count() <= 120);
        // structure the model needs survives
        assert_eq!(spec.parameters["properties"]["id"]["type"], "string");
    }
}
