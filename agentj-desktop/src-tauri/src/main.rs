//! agentj-desktop backend.
//!
//! A thin Tauri host around the REAL agent loop from the `agentj` library. It holds one *repo
//! context* (the session built for a working directory) behind a lock; `open_repo` rebuilds it for
//! a directory the user picks in the app. Each `send_prompt` runs a turn on a background task and
//! forwards every `AgentEvent` to the webview as an `"agent-event"`. When the agent saves an html
//! `blueprint`, the backend reads it and emits a `"blueprint"` event so the React UI can dock it
//! beside the chat — the CLI's browser-open is suppressed here via `AGENTJ_DESKTOP=1`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
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

/// The session built for one working directory. Swapped wholesale when the user opens another repo.
struct RepoCtx {
    sess: Session,
    store: Arc<Store>,
    root: String,
    branch: Option<String>,
    system: String,
}

struct AppState {
    /// The active repo's session. Locked briefly to clone the session or swap the whole context.
    ctx: Mutex<RepoCtx>,
    /// The conversation, seeded with the active repo's system prompt. Reset when the repo changes.
    messages: Arc<Mutex<Vec<ChatMessage>>>,
    /// The in-flight turn, so `interrupt` can abort it.
    turn: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    running: Arc<AtomicBool>,
}

#[derive(serde::Serialize, Clone)]
struct RepoInfo {
    root: String,
    branch: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct BlueprintPayload {
    name: String,
    html: String,
}

/// git top-level for `dir` (else `dir` itself) — so opening any folder inside a repo roots at the repo.
fn git_root(dir: &str) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| dir.to_string())
}

fn git_branch(root: &str) -> Option<String> {
    std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The working directory the app launched in (its git root, else cwd).
fn launch_root() -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into());
    git_root(&cwd)
}

/// Build a full session for `root`, mirroring the CLI's interactive setup. Provider/model resolve
/// from THIS repo's config, so a per-repo `.aj/aj.json` is honored. If nothing resolves the context
/// still builds with `Llm::Unconfigured` — a later `send_prompt` surfaces the error in the transcript.
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
    let branch = git_branch(root);

    let store = Arc::new(Store::mint(root, branch.clone()).expect("mint session store"));
    let jobs = jobs::JobManager::new(root.to_string());
    let tools = tools::Tools::with_session(PathBuf::from(root), jobs, None, Some(store.clone()));

    let sess = Session {
        llm: Arc::new(llm),
        tools: Arc::new(tools),
        cfg: Arc::new(run_cfg),
    };
    RepoCtx { sess, store, root: root.to_string(), branch, system }
}

fn build_state() -> AppState {
    std::env::set_var("AGENTJ_DESKTOP", "1"); // render blueprints in-app, not the system browser
    let ctx = build_ctx(&launch_root());
    let messages = Arc::new(Mutex::new(vec![ChatMessage::system(ctx.system.clone())]));
    AppState {
        ctx: Mutex::new(ctx),
        messages,
        turn: Mutex::new(None),
        running: Arc::new(AtomicBool::new(false)),
    }
}

/// The repo the app is currently working in (for the header on mount).
#[tauri::command]
fn current_repo(state: State<'_, AppState>) -> RepoInfo {
    let c = state.ctx.lock().unwrap();
    RepoInfo { root: c.root.clone(), branch: c.branch.clone() }
}

/// Switch the working directory. Rebuilds the session (fresh AGENTS.md, tools, artifact store),
/// resets the conversation, and announces the change so the UI clears the transcript. Refused while
/// a turn is running — interrupt it first.
#[tauri::command]
fn open_repo(path: String, app: AppHandle, state: State<'_, AppState>) -> Result<RepoInfo, String> {
    if state.running.load(Ordering::SeqCst) {
        return Err("a turn is running — interrupt it before switching repos".into());
    }
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let root = git_root(&path);
    let ctx = build_ctx(&root);
    let info = RepoInfo { root: ctx.root.clone(), branch: ctx.branch.clone() };
    *state.messages.lock().unwrap() = vec![ChatMessage::system(ctx.system.clone())];
    *state.ctx.lock().unwrap() = ctx;
    let _ = app.emit("repo-changed", info.clone());
    Ok(info)
}

/// Start (or continue) a turn against the active repo. Rejects if a turn is already running.
#[tauri::command]
fn send_prompt(prompt: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("a turn is already running".into());
    }
    let (sess, store) = {
        let c = state.ctx.lock().unwrap();
        (c.sess.clone(), c.store.clone())
    };
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

/// Abort the in-flight turn (if any).
#[tauri::command]
fn interrupt(state: State<'_, AppState>) {
    if let Some(h) = state.turn.lock().unwrap().take() {
        h.abort();
    }
    state.running.store(false, Ordering::SeqCst);
}

/// Read a named session artifact from the active repo (feeds the blueprint pane).
#[tauri::command]
fn read_artifact(name: String, state: State<'_, AppState>) -> Option<String> {
    state.ctx.lock().unwrap().store.read_artifact(&name)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(build_state())
        .invoke_handler(tauri::generate_handler![
            current_repo,
            open_repo,
            send_prompt,
            interrupt,
            read_artifact
        ])
        .run(tauri::generate_context!())
        .expect("error while running agentj-desktop");
}
