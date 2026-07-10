//! agentj-desktop backend.
//!
//! agentj always works inside a git worktree. The app holds MANY live sessions at once — each is a
//! worktree (its own checkout, artifact store, and conversation) grouped under the project (base
//! repo) it belongs to, which is what the two-tier tab bar renders. Every command is scoped to a
//! session id. Agent events stream to the webview tagged with their session id so the UI routes them
//! to the right tab.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod worktree;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agentj::agent::{self, Session};
use agentj::config::{self, AppConfig};
use agentj::events::AgentEvent;
use agentj::model::{preflight, resolve_model, resolve_provider, ModelConfig, Provider, Selector};
use agentj::prompt;
use agentj::mcp::client::{connect_all, McpClients, McpOutcome};
use agentj::provider::openai::list_models as provider_list_models;
use agentj::provider::{ChatMessage, Llm};
use agentj::session::Session as Store;
use agentj::{jobs, tools};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::unbounded_channel;

/// The agent session built for one worktree.
struct RepoCtx {
    /// The model client + run config. Behind a Mutex so a session can switch models at runtime
    /// (`set_session_model` rebuilds and swaps it); `start_turn` clones it out per turn.
    sess: Mutex<Session>,
    /// The active model id, for display (kept in step with `sess`).
    model: Mutex<String>,
    store: Arc<Store>,
    root: String,
    branch: Option<String>,
    base: String,
    system: String,
    /// Connection result for each MCP server configured in this worktree (for the tool-status view).
    mcp_status: Vec<McpServerStatus>,
}

/// A model chosen from the app — either as the global default or for one session. `provider` is
/// "azure" or "custom" (the wired OpenAI-compatible providers).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelChoice {
    provider: String,
    model: String,
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    api_version: Option<String>,
}

fn nonempty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

/// Build a runnable `ModelConfig` straight from an explicit choice (bypassing config resolution).
fn choice_to_config(c: &ModelChoice) -> Result<ModelConfig, String> {
    let provider = Provider::parse(&c.provider)
        .filter(|p| matches!(p, Provider::Azure | Provider::Custom))
        .ok_or_else(|| format!("provider `{}` is not selectable (use azure or custom)", c.provider))?;
    Ok(ModelConfig {
        provider,
        model_id: c.model.clone(),
        base_url: c.base_url.clone(),
        api_key: nonempty(c.api_key.clone()),
        api_version: nonempty(c.api_version.clone()),
    })
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct McpServerStatus {
    name: String,
    /// "ok" | "needs_auth" | "error".
    state: String,
    tools: usize,
    detail: Option<String>,
}

/// Connect this worktree's `.mcp.json` servers (if any). Runs on the app's long-lived runtime so the
/// clients stay usable; returns the shared clients + a serializable status per server.
fn connect_mcp(root: &str) -> (Option<Arc<McpClients>>, Vec<McpServerStatus>) {
    let configs = agentj::mcp::config::load_mcp_servers(root);
    if configs.is_empty() {
        return (None, Vec::new());
    }
    let (clients, statuses) = tauri::async_runtime::block_on(connect_all(&configs));
    let lite = statuses
        .into_iter()
        .map(|s| {
            let (state, tools, detail) = match s.outcome {
                McpOutcome::Ok(n) => ("ok", n, None),
                McpOutcome::NeedsAuth => {
                    ("needs_auth", 0, Some(format!("run `agentj mcp login {}`", s.name)))
                }
                McpOutcome::Err(e) => ("error", 0, Some(e)),
            };
            McpServerStatus { name: s.name, state: state.into(), tools, detail }
        })
        .collect();
    (Some(Arc::new(clients)), lite)
}

/// One open session: a worktree's context, its conversation, and its turn state. Sessions run
/// independently — several can have live turns at once (each in its own worktree).
struct SessionEntry {
    id: String,
    ctx: RepoCtx,
    messages: Arc<Mutex<Vec<ChatMessage>>>,
    running: Arc<AtomicBool>,
    turn: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

struct AppState {
    /// Open sessions in tab order.
    sessions: Mutex<Vec<Arc<SessionEntry>>>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    id: String,
    /// The worktree the session operates in.
    root: String,
    branch: Option<String>,
    /// The project this session belongs to (base repo path) — the top-tier grouping.
    base: String,
    project_name: String,
    is_worktree: bool,
    /// The active model id for this session (may differ from the global default).
    model: String,
    /// A one-off message to show first in the session's transcript (e.g. a provisioning fallback).
    notice: Option<String>,
}

impl SessionMeta {
    fn of(e: &SessionEntry) -> Self {
        let c = &e.ctx;
        SessionMeta {
            id: e.id.clone(),
            root: c.root.clone(),
            branch: c.branch.clone(),
            base: c.base.clone(),
            project_name: worktree::dir_name(&c.base),
            is_worktree: c.root != c.base,
            model: c.model.lock().unwrap().clone(),
            notice: None,
        }
    }
}

/// An agent event tagged with the session it belongs to, so the UI routes it to the right tab.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tagged {
    session_id: String,
    event: AgentEvent,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TodosPayload {
    session_id: String,
    /// Raw markdown of the `todos` artifact (the UI parses the `- [ ]` / `- [x]` lines).
    content: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    /// Path relative to the worktree root.
    rel: String,
    is_dir: bool,
}

/// Build a full session for a worktree `root`, mirroring the CLI's interactive setup.
fn build_ctx(root: &str, choice: Option<&ModelChoice>) -> RepoCtx {
    let app_cfg = AppConfig::load(root);

    // An explicit choice (per-session model) is used verbatim; otherwise resolve the global default
    // from config. Either way, a failure leaves the session Unconfigured (a friendly nudge on run).
    let resolved = match choice {
        Some(c) => choice_to_config(c)
            .and_then(|cfg| Llm::from_config(&cfg).map(|l| (l, cfg.model_id)).map_err(|e| e.to_string())),
        None => {
            let provider = resolve_provider(None, &app_cfg);
            let sel = Selector { provider, model: None, base_url: None };
            preflight(&sel, &app_cfg)
                .and_then(|_| resolve_model(&sel, &app_cfg))
                .and_then(|cfg| Llm::from_config(&cfg).map(|l| (l, cfg.model_id)).map_err(|e| e.to_string()))
        }
    };
    let (llm, model_id) = resolved.unwrap_or((Llm::Unconfigured, "(none)".to_string()));

    let company = AppConfig::env_or_file("AGENTJ_COMPANY", app_cfg.company.as_deref());
    let mut run_cfg = config::Config::from_sources(&model_id, &app_cfg);
    // The desktop host manages background jobs: a turn ends and goes idle when the model has nothing
    // left to do (so the user can send another message), and a per-session waker starts a fresh turn
    // when a job pings (finish / soft timeout) — see `spawn_waker`.
    run_cfg.host_manages_jobs = true;
    let system = prompt::system_prompt(root, company.as_deref());
    let branch = worktree::current_branch(root);
    let base = worktree::base_repo(root).unwrap_or_else(|| root.to_string());

    let store = Arc::new(Store::mint(root, branch.clone()).expect("mint session store"));
    let jobs = jobs::JobManager::new(root.to_string());
    let (mcp, mcp_status) = connect_mcp(root);
    let tools = tools::Tools::with_session(PathBuf::from(root), jobs, mcp, Some(store.clone()));

    let sess = Session {
        llm: Arc::new(llm),
        tools: Arc::new(tools),
        cfg: Arc::new(run_cfg),
    };
    RepoCtx {
        sess: Mutex::new(sess),
        model: Mutex::new(model_id),
        store,
        root: root.to_string(),
        branch,
        base,
        system,
        mcp_status,
    }
}

fn make_entry(root: &str) -> Arc<SessionEntry> {
    let ctx = build_ctx(root, None);
    let messages = vec![ChatMessage::system(ctx.system.clone())];
    Arc::new(SessionEntry {
        id: worktree::short_id(),
        ctx,
        messages: Arc::new(Mutex::new(messages)),
        running: Arc::new(AtomicBool::new(false)),
        turn: Mutex::new(None),
    })
}

fn find(state: &AppState, id: &str) -> Option<Arc<SessionEntry>> {
    state.sessions.lock().unwrap().iter().find(|e| e.id == id).cloned()
}

fn persist(state: &AppState) {
    let roots: Vec<String> = state
        .sessions
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.ctx.root.clone())
        .collect();
    worktree::remember_sessions(&roots);
}

// ---- commands -------------------------------------------------------------

/// Every open session, in tab order (the UI groups them by `base` into the two tiers).
#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Vec<SessionMeta> {
    state.sessions.lock().unwrap().iter().map(|e| SessionMeta::of(e)).collect()
}

/// Inspect a picked directory: git-ness, base repo, default branch, and its worktrees (marking the
/// ones already open as a session).
#[tauri::command]
fn inspect_repo(path: String, state: State<'_, AppState>) -> Result<worktree::RepoScan, String> {
    let open: Vec<String> =
        state.sessions.lock().unwrap().iter().map(|e| e.ctx.root.clone()).collect();
    worktree::inspect(&path, &open)
}

/// Provision a fresh long-running worktree off `origin/<default>` and open it as a new session.
#[tauri::command]
fn provision_worktree(
    base: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SessionMeta, String> {
    let worktree::Provisioned { path, notice } = worktree::provision(&base)?;
    let entry = make_entry(&path);
    let mut meta = SessionMeta::of(&entry);
    meta.notice = notice;
    spawn_waker(entry.clone(), app);
    state.sessions.lock().unwrap().push(entry);
    persist(&state);
    Ok(meta)
}

/// Open an existing worktree as a session — focusing it if it's already open.
#[tauri::command]
fn open_worktree(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SessionMeta, String> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    if !worktree::is_git(&path) {
        return Err(format!("not a git repository: {path}"));
    }
    if let Some(e) = state.sessions.lock().unwrap().iter().find(|e| e.ctx.root == path) {
        return Ok(SessionMeta::of(e)); // already open — the UI just selects its tab
    }
    let entry = make_entry(&path);
    let meta = SessionMeta::of(&entry);
    spawn_waker(entry.clone(), app);
    state.sessions.lock().unwrap().push(entry);
    persist(&state);
    Ok(meta)
}

/// Close a session (aborts its turn; the worktree stays on disk).
#[tauri::command]
fn close_session(id: String, state: State<'_, AppState>) {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(pos) = sessions.iter().position(|e| e.id == id) {
        let entry = sessions.remove(pos);
        let handle = entry.turn.lock().unwrap().take();
        if let Some(h) = handle {
            h.abort();
        }
    }
    drop(sessions);
    persist(&state);
}

/// Start (or continue) a turn for a session.
#[tauri::command]
fn send_prompt(
    session_id: String,
    prompt: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let entry = find(&state, &session_id).ok_or("unknown session")?;
    if !start_turn(entry, app, Some(prompt)) {
        return Err("a turn is already running in this session".into());
    }
    Ok(())
}

/// Run a turn for `entry`. With `Some(prompt)` the user message seeds it; with `None` it just runs
/// (the loop drains any pending job nudges at its start) — that's how the waker wakes the agent when
/// a background job pings. Returns false if a turn is already running. Fire-and-forget.
fn start_turn(entry: Arc<SessionEntry>, app: AppHandle, prompt: Option<String>) -> bool {
    if entry.running.swap(true, Ordering::SeqCst) {
        return false;
    }
    let sess = entry.ctx.sess.lock().unwrap().clone();
    let store = entry.ctx.store.clone();
    let messages = entry.messages.clone();
    let running = entry.running.clone();
    let sid = entry.id.clone();

    let mut msgs = {
        let mut g = messages.lock().unwrap();
        if let Some(p) = prompt {
            g.push(ChatMessage::user(p));
        }
        g.clone()
    };

    let (tx, mut rx) = unbounded_channel::<AgentEvent>();
    let app_fwd = app.clone();
    let fwd = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = app_fwd.emit("agent-event", Tagged { session_id: sid.clone(), event: ev.clone() });
            if let AgentEvent::Artifact { name } = &ev {
                if name == "todos" {
                    if let Some(content) = store.read_artifact("todos") {
                        let _ = app_fwd
                            .emit("todos", TodosPayload { session_id: sid.clone(), content });
                    }
                }
            }
        }
    });

    let handle = tauri::async_runtime::spawn(async move {
        let _ = agent::run_turn(&sess, &mut msgs, &tx, true, None).await;
        drop(tx);
        let _ = fwd.await;
        *messages.lock().unwrap() = msgs;
        running.store(false, Ordering::SeqCst);
    });
    *entry.turn.lock().unwrap() = Some(handle);
    true
}

/// Per-session background-job waker. When a job pings (finish / soft timeout) and the session is idle,
/// start a fresh turn so the agent reacts — even though no user message arrived. A running turn drains
/// nudges itself, so we only step in once the session goes idle.
fn spawn_waker(entry: Arc<SessionEntry>, app: AppHandle) {
    use std::time::Duration;
    let jobs = entry.ctx.sess.lock().unwrap().tools.jobs.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            jobs.wait_nudge().await; // a nudge is queued (not consumed)
            // Let any in-flight turn go idle first — it drains the nudge on its own.
            while entry.running.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            if jobs.has_nudges() {
                start_turn(entry.clone(), app.clone(), None);
                tokio::time::sleep(Duration::from_millis(200)).await;
                while entry.running.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }
        }
    });
}

#[tauri::command]
fn interrupt(session_id: String, state: State<'_, AppState>) {
    if let Some(entry) = find(&state, &session_id) {
        if let Some(h) = entry.turn.lock().unwrap().take() {
            h.abort();
        }
        entry.running.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
fn read_artifact(session_id: String, name: String, state: State<'_, AppState>) -> Option<String> {
    find(&state, &session_id).and_then(|e| e.ctx.store.read_artifact(&name))
}

/// The session's live `todos` markdown, or null if it hasn't created any yet.
#[tauri::command]
fn read_todos(session_id: String, state: State<'_, AppState>) -> Option<String> {
    find(&state, &session_id).and_then(|e| e.ctx.store.read_artifact("todos"))
}

/// Resolve a repo-relative path against the worktree root, refusing anything that escapes it.
fn safe_join(root: &str, rel: &str) -> Option<PathBuf> {
    let base = std::fs::canonicalize(root).ok()?;
    let joined = std::fs::canonicalize(base.join(rel)).ok()?;
    joined.starts_with(&base).then_some(joined)
}

/// List one directory of the session's worktree (dirs first, then files; hidden/noise dirs skipped),
/// for the file explorer. `sub` is a repo-relative subdirectory ("" for the root).
#[tauri::command]
fn list_files(session_id: String, sub: String, state: State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
    const SKIP: &[&str] = &[".git", "node_modules", "target", "dist", ".aj"];
    let entry = find(&state, &session_id).ok_or("unknown session")?;
    let root = entry.ctx.root.clone();
    let dir = safe_join(&root, &sub).ok_or("path is outside the worktree")?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let is_dir = e.path().is_dir();
        if is_dir && SKIP.contains(&name.as_str()) {
            continue;
        }
        let rel = if sub.is_empty() { name.clone() } else { format!("{sub}/{name}") };
        out.push(FileEntry { name, rel, is_dir });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Open a worktree file in the OS default application.
#[tauri::command]
fn open_path(session_id: String, rel: String, state: State<'_, AppState>) -> Result<(), String> {
    let entry = find(&state, &session_id).ok_or("unknown session")?;
    let path = safe_join(&entry.ctx.root, &rel).ok_or("path is outside the worktree")?;
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BuiltinTool {
    name: String,
    description: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    /// The built-in tools this session advertises to the model.
    builtins: Vec<BuiltinTool>,
    /// Configured MCP servers and how their connection went.
    mcp: Vec<McpServerStatus>,
    /// Total MCP tools available (sum over connected servers).
    mcp_tool_count: usize,
}

/// The tools available to a session: built-ins plus each configured MCP server's connection status.
#[tauri::command]
fn tool_status(session_id: String, state: State<'_, AppState>) -> Result<ToolStatus, String> {
    let entry = find(&state, &session_id).ok_or("unknown session")?;
    let builtins = tools::tool_specs(true, true, None)
        .into_iter()
        .map(|s| BuiltinTool { name: s.name, description: s.description })
        .collect();
    let mcp = entry.ctx.mcp_status.clone();
    let mcp_tool_count = mcp.iter().filter(|m| m.state == "ok").map(|m| m.tools).sum();
    Ok(ToolStatus { builtins, mcp, mcp_tool_count })
}

// ---- model selection ------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderInfo {
    provider: String,
    base_url: String,
    model: String,
    api_version: String,
    has_key: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelSettings {
    default_provider: String,
    default_model: String,
    providers: Vec<ProviderInfo>,
}

/// Fill blank fields (key / base_url / api-version) from the stored provider config, so switching
/// models doesn't force the user to re-type a saved key.
fn fill_from_config(mut c: ModelChoice, app: &AppConfig) -> ModelChoice {
    let stored = match c.provider.as_str() {
        "azure" => Some(&app.providers.azure),
        "custom" => Some(&app.providers.custom),
        _ => None,
    };
    if let Some(p) = stored {
        if c.base_url.is_empty() {
            if let Some(b) = p.base_url() {
                c.base_url = b;
            }
        }
        if c.api_key.as_deref().unwrap_or("").is_empty() {
            c.api_key = p.api_key();
        }
        if c.api_version.as_deref().unwrap_or("").is_empty() {
            c.api_version = p.api_version();
        }
    }
    c
}

fn provider_info(name: &str, p: &agentj::config::ProviderConfig) -> ProviderInfo {
    ProviderInfo {
        provider: name.to_string(),
        base_url: p.base_url().unwrap_or_default(),
        model: p.model().unwrap_or_default(),
        api_version: p.api_version().unwrap_or_default(),
        has_key: p.api_key().is_some(),
    }
}

/// The global default provider+model plus the stored Azure/Custom provider configs, so the Models
/// panel can prefill. Reads the merged config (global + the active session's repo, if any).
#[tauri::command]
fn model_settings(state: State<'_, AppState>) -> ModelSettings {
    let root = state.sessions.lock().unwrap().first().map(|e| e.ctx.root.clone());
    let app_cfg = AppConfig::load(root.as_deref().unwrap_or("."));
    let provider = resolve_provider(None, &app_cfg);
    let default_model = resolve_model(&Selector { provider, model: None, base_url: None }, &app_cfg)
        .map(|c| c.model_id)
        .unwrap_or_default();
    ModelSettings {
        default_provider: provider.as_str().to_string(),
        default_model,
        providers: vec![
            provider_info("azure", &app_cfg.providers.azure),
            provider_info("custom", &app_cfg.providers.custom),
        ],
    }
}

/// Persist a provider+model as the global default (`~/.config/aj/aj.json`). New sessions pick it up.
#[tauri::command]
fn set_default_model(choice: ModelChoice) -> Result<String, String> {
    let app_cfg = AppConfig::load(".");
    let choice = fill_from_config(choice, &app_cfg);
    let cfg = choice_to_config(&choice)?; // validates provider + that it builds
    Llm::from_config(&cfg).map_err(|e| e.to_string())?;
    let key = choice.api_key.as_deref().unwrap_or("");
    if key.is_empty() {
        return Err("an API key is required (none entered and none stored)".into());
    }
    config::write_provider_config(
        &choice.provider,
        &choice.model,
        &choice.base_url,
        key,
        choice.api_version.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    Ok(cfg.model_id)
}

/// Best-effort model enumeration for an OpenAI-compatible endpoint (`GET {base_url}/models`).
/// Empty when unsupported — the UI then relies on free-text entry.
#[tauri::command]
async fn list_models(
    base_url: String,
    api_key: Option<String>,
    api_version: Option<String>,
) -> Vec<String> {
    provider_list_models(&base_url, api_key.as_deref(), api_version.as_deref()).await
}

/// Switch ONE session to a different model at runtime — rebuilds its client + run config (keeping its
/// tools and conversation) and swaps them in. Returns the new model id.
#[tauri::command]
fn set_session_model(
    state: State<'_, AppState>,
    session_id: String,
    choice: ModelChoice,
) -> Result<String, String> {
    let entry = find(&state, &session_id).ok_or_else(|| "no such session".to_string())?;
    let app_cfg = AppConfig::load(&entry.ctx.root);
    let choice = fill_from_config(choice, &app_cfg);
    let cfg = choice_to_config(&choice)?;
    let llm = Llm::from_config(&cfg).map_err(|e| e.to_string())?;
    let mut run_cfg = config::Config::from_sources(&cfg.model_id, &app_cfg);
    run_cfg.host_manages_jobs = true;
    {
        let mut guard = entry.ctx.sess.lock().unwrap();
        let tools = guard.tools.clone();
        *guard = Session { llm: Arc::new(llm), tools, cfg: Arc::new(run_cfg) };
    }
    *entry.ctx.model.lock().unwrap() = cfg.model_id.clone();
    Ok(cfg.model_id)
}

/// Open a URL in the user's default browser (external links, and the "open in browser" escape hatch
/// for pages that refuse to be framed in an in-app view).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let (cmd, args): (&str, Vec<&str>) = ("open", vec![&url]);
    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, Vec<&str>) = ("cmd", vec!["/C", "start", "", &url]);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let (cmd, args): (&str, Vec<&str>) = ("xdg-open", vec![&url]);
    std::process::Command::new(cmd)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn build_state() -> AppState {
    // Reopen the sessions from last launch whose worktrees still look like git checkouts.
    let sessions: Vec<Arc<SessionEntry>> = worktree::remembered_sessions()
        .into_iter()
        .filter(|p| worktree::is_git(p))
        .map(|p| make_entry(&p))
        .collect();
    AppState { sessions: Mutex::new(sessions) }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(build_state())
        .setup(|app| {
            // Wake reopened sessions on their background-job pings, too.
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            for entry in state.sessions.lock().unwrap().iter() {
                spawn_waker(entry.clone(), handle.clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            inspect_repo,
            provision_worktree,
            open_worktree,
            close_session,
            send_prompt,
            interrupt,
            read_artifact,
            read_todos,
            list_files,
            open_path,
            tool_status,
            model_settings,
            set_default_model,
            list_models,
            set_session_model,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running agentj-desktop");
}
