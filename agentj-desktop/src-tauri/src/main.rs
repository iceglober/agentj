//! agentj-desktop backend.
//!
//! agentj always works inside a git worktree. The app holds MANY live sessions at once — each is a
//! worktree (its own checkout, artifact store, and conversation) grouped under the project (base
//! repo) it belongs to, which is what the two-tier tab bar renders. Every command is scoped to a
//! session id. Agent events stream to the webview tagged with their session id so the UI routes them
//! to the right tab. A saved html `blueprint` is read and emitted for the docked pane; the CLI's
//! browser-open is suppressed here via `AGENTJ_DESKTOP=1`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod worktree;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agentj::agent::{self, Session};
use agentj::config::{self, AppConfig};
use agentj::events::AgentEvent;
use agentj::model::{preflight, resolve_model, resolve_provider, Selector};
use agentj::prompt;
use agentj::provider::{ChatMessage, Llm};
use agentj::session::Session as Store;
use agentj::{jobs, tools};

use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::unbounded_channel;

/// The agent session built for one worktree.
struct RepoCtx {
    sess: Session,
    store: Arc<Store>,
    root: String,
    branch: Option<String>,
    base: String,
    system: String,
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
struct BlueprintPayload {
    session_id: String,
    name: String,
    html: String,
}

/// Build a full session for a worktree `root`, mirroring the CLI's interactive setup.
fn build_ctx(root: &str) -> RepoCtx {
    let app_cfg = AppConfig::load(root);
    let provider = resolve_provider(None, &app_cfg);
    let sel = Selector { provider, model: None, base_url: None };

    let (llm, model_id) = match preflight(&sel, &app_cfg)
        .and_then(|_| resolve_model(&sel, &app_cfg))
        .and_then(|cfg| Llm::from_config(&cfg).map(|l| (cfg, l)).map_err(|e| e.to_string()))
    {
        Ok((cfg, llm)) => (llm, cfg.model_id),
        Err(_) => (Llm::Unconfigured, "(none)".to_string()),
    };

    let company = AppConfig::env_or_file("AGENTJ_COMPANY", app_cfg.company.as_deref());
    let run_cfg = config::Config::from_sources(&model_id, &app_cfg);
    let system = prompt::system_prompt(root, company.as_deref());
    let branch = worktree::current_branch(root);
    let base = worktree::base_repo(root).unwrap_or_else(|| root.to_string());

    let store = Arc::new(Store::mint(root, branch.clone()).expect("mint session store"));
    let jobs = jobs::JobManager::new(root.to_string());
    let tools = tools::Tools::with_session(PathBuf::from(root), jobs, None, Some(store.clone()));

    let sess = Session {
        llm: Arc::new(llm),
        tools: Arc::new(tools),
        cfg: Arc::new(run_cfg),
    };
    RepoCtx { sess, store, root: root.to_string(), branch, base, system }
}

fn make_entry(root: &str) -> Arc<SessionEntry> {
    let ctx = build_ctx(root);
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
fn provision_worktree(base: String, state: State<'_, AppState>) -> Result<SessionMeta, String> {
    let path = worktree::provision(&base)?;
    let entry = make_entry(&path);
    let meta = SessionMeta::of(&entry);
    state.sessions.lock().unwrap().push(entry);
    persist(&state);
    Ok(meta)
}

/// Open an existing worktree as a session — focusing it if it's already open.
#[tauri::command]
fn open_worktree(path: String, state: State<'_, AppState>) -> Result<SessionMeta, String> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    if let Some(e) = state.sessions.lock().unwrap().iter().find(|e| e.ctx.root == path) {
        return Ok(SessionMeta::of(e)); // already open — the UI just selects its tab
    }
    let entry = make_entry(&path);
    let meta = SessionMeta::of(&entry);
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
    if entry.running.swap(true, Ordering::SeqCst) {
        return Err("a turn is already running in this session".into());
    }
    let sess = entry.ctx.sess.clone();
    let store = entry.ctx.store.clone();
    let messages = entry.messages.clone();
    let running = entry.running.clone();
    let sid = session_id.clone();

    let mut msgs = {
        let mut g = messages.lock().unwrap();
        g.push(ChatMessage::user(prompt));
        g.clone()
    };

    let (tx, mut rx) = unbounded_channel::<AgentEvent>();
    let app_fwd = app.clone();
    let fwd = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = app_fwd.emit("agent-event", Tagged { session_id: sid.clone(), event: ev.clone() });
            if let AgentEvent::Artifact { name, format } = &ev {
                if format == "html" {
                    if let Some(html) = store.read_artifact(name) {
                        let _ = app_fwd.emit(
                            "blueprint",
                            BlueprintPayload { session_id: sid.clone(), name: name.clone(), html },
                        );
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
    Ok(())
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

fn build_state() -> AppState {
    std::env::set_var("AGENTJ_DESKTOP", "1"); // render blueprints in-app, not the system browser
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
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            inspect_repo,
            provision_worktree,
            open_worktree,
            close_session,
            send_prompt,
            interrupt,
            read_artifact
        ])
        .run(tauri::generate_context!())
        .expect("error while running agentj-desktop");
}
