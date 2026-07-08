//! agentj-desktop backend.
//!
//! agentj always works inside a git worktree. The app opens a *workspace* — either an existing
//! worktree, or a freshly provisioned one branched off `origin/<default>` (a long-running worktree
//! that starts from the current state of the remote). The active workspace's session is held behind
//! a lock; commands run turns against it and stream `AgentEvent`s to the webview. A saved html
//! `blueprint` is read and emitted so the UI docks it beside the chat (the CLI's browser-open is
//! suppressed here via `AGENTJ_DESKTOP=1`).
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

/// The session built for one workspace (a worktree). Swapped wholesale when the workspace changes.
struct RepoCtx {
    sess: Session,
    store: Arc<Store>,
    root: String,
    branch: Option<String>,
    base: String,
    system: String,
}

struct AppState {
    /// The active workspace's session — `None` until one is opened (the Welcome screen shows then).
    ctx: Mutex<Option<RepoCtx>>,
    messages: Arc<Mutex<Vec<ChatMessage>>>,
    turn: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    running: Arc<AtomicBool>,
}

#[derive(serde::Serialize, Clone)]
struct RepoInfo {
    /// The active worktree's path (where the agent operates).
    root: String,
    branch: Option<String>,
    /// The base repository this worktree belongs to.
    base: String,
    /// Whether `root` is a linked worktree (vs. the base checkout itself).
    is_worktree: bool,
}

impl RepoInfo {
    fn of(c: &RepoCtx) -> Self {
        RepoInfo {
            root: c.root.clone(),
            branch: c.branch.clone(),
            base: c.base.clone(),
            is_worktree: c.root != c.base,
        }
    }
}

#[derive(serde::Serialize, Clone)]
struct BlueprintPayload {
    name: String,
    html: String,
}

/// Build a full session for a worktree `root`, mirroring the CLI's interactive setup. Provider/model
/// resolve from this checkout's config. If nothing resolves it still builds with `Llm::Unconfigured`.
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

/// Activate `ctx` as the workspace: reset history, remember it for next launch, announce the change.
fn set_workspace(state: &AppState, app: &AppHandle, ctx: RepoCtx) -> RepoInfo {
    let info = RepoInfo::of(&ctx);
    *state.messages.lock().unwrap() = vec![ChatMessage::system(ctx.system.clone())];
    *state.ctx.lock().unwrap() = Some(ctx);
    worktree::remember_workspace(&info.root);
    let _ = app.emit("repo-changed", info.clone());
    info
}

// ---- commands -------------------------------------------------------------

/// The active workspace, or `null` when none is open (→ Welcome screen).
#[tauri::command]
fn current_repo(state: State<'_, AppState>) -> Option<RepoInfo> {
    state.ctx.lock().unwrap().as_ref().map(RepoInfo::of)
}

/// Inspect a picked directory: is it git, what's its base repo + default branch, and which worktrees
/// already exist (so the user can resume one instead of provisioning a fresh one).
#[tauri::command]
fn inspect_repo(path: String, state: State<'_, AppState>) -> Result<worktree::RepoScan, String> {
    let active = state.ctx.lock().unwrap().as_ref().map(|c| c.root.clone());
    worktree::inspect(&path, active.as_deref())
}

/// Provision a fresh long-running worktree off `origin/<default>` (fetching first) and open it.
#[tauri::command]
fn provision_worktree(
    base: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RepoInfo, String> {
    if state.running.load(Ordering::SeqCst) {
        return Err("a turn is running — interrupt it before switching workspaces".into());
    }
    let path = worktree::provision(&base)?;
    Ok(set_workspace(&state, &app, build_ctx(&path)))
}

/// Open an existing worktree (or the base checkout) as the workspace.
#[tauri::command]
fn open_worktree(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RepoInfo, String> {
    if state.running.load(Ordering::SeqCst) {
        return Err("a turn is running — interrupt it before switching workspaces".into());
    }
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    Ok(set_workspace(&state, &app, build_ctx(&path)))
}

/// Start (or continue) a turn against the active workspace.
#[tauri::command]
fn send_prompt(prompt: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let (sess, store) = {
        let guard = state.ctx.lock().unwrap();
        let Some(c) = guard.as_ref() else {
            return Err("open a workspace first".into());
        };
        (c.sess.clone(), c.store.clone())
    };
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("a turn is already running".into());
    }
    let messages = state.messages.clone();
    let running = state.running.clone();

    let mut msgs = {
        let mut g = messages.lock().unwrap();
        g.push(ChatMessage::user(prompt));
        g.clone()
    };

    let (tx, mut rx) = unbounded_channel::<AgentEvent>();
    let app_fwd = app.clone();
    let fwd = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = app_fwd.emit("agent-event", &ev);
            if let AgentEvent::Artifact { name, format } = &ev {
                if format == "html" {
                    if let Some(html) = store.read_artifact(name) {
                        let _ = app_fwd
                            .emit("blueprint", BlueprintPayload { name: name.clone(), html });
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
    *state.turn.lock().unwrap() = Some(handle);
    Ok(())
}

#[tauri::command]
fn interrupt(state: State<'_, AppState>) {
    if let Some(h) = state.turn.lock().unwrap().take() {
        h.abort();
    }
    state.running.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn read_artifact(name: String, state: State<'_, AppState>) -> Option<String> {
    state
        .ctx
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|c| c.store.read_artifact(&name))
}

fn build_state() -> AppState {
    std::env::set_var("AGENTJ_DESKTOP", "1"); // render blueprints in-app, not the system browser
    // Resume the last workspace if it still looks like a git checkout; otherwise start on Welcome.
    let ctx = worktree::last_workspace()
        .filter(|p| worktree::is_git(p))
        .map(|p| build_ctx(&p));
    let messages = match &ctx {
        Some(c) => vec![ChatMessage::system(c.system.clone())],
        None => Vec::new(),
    };
    AppState {
        ctx: Mutex::new(ctx),
        messages: Arc::new(Mutex::new(messages)),
        turn: Mutex::new(None),
        running: Arc::new(AtomicBool::new(false)),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(build_state())
        .invoke_handler(tauri::generate_handler![
            current_repo,
            inspect_repo,
            provision_worktree,
            open_worktree,
            send_prompt,
            interrupt,
            read_artifact
        ])
        .run(tauri::generate_context!())
        .expect("error while running agentj-desktop");
}
