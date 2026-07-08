//! agentj-desktop backend.
//!
//! A thin Tauri host around the REAL agent loop from the `agentj` library: it builds one
//! `agent::Session` at startup (same construction the CLI uses), then each `send_prompt` runs a
//! turn on a background task and forwards every `AgentEvent` to the webview as an `"agent-event"`.
//! When the agent saves an html `blueprint`, the backend reads it and emits a `"blueprint"` event so
//! the React UI can dock it beside the chat — the browser-open the CLI does is suppressed here via
//! `AGENTJ_DESKTOP=1`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

/// Everything the commands need. History and the running-turn flag are shared so a turn task can
/// write the conversation back and the next turn continues from it.
struct AppState {
    sess: Session,
    /// The artifact store handle (same one inside `sess.tools`) — used to read a saved blueprint's
    /// html to hand to the UI.
    store: Arc<Store>,
    /// The conversation, seeded with the system prompt. A turn clones it, runs, and writes it back.
    messages: Arc<Mutex<Vec<ChatMessage>>>,
    /// The in-flight turn, so `interrupt` can abort it.
    turn: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    running: Arc<AtomicBool>,
}

#[derive(serde::Serialize, Clone)]
struct BlueprintPayload {
    name: String,
    html: String,
}

/// Repo root for the process's working directory (git top-level, else cwd) — the agent operates here.
fn repo_root() -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into());
    std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(cwd)
}

/// Build the agent session once, mirroring the CLI's interactive setup. If no provider resolves the
/// session still starts with `Llm::Unconfigured` — a `send_prompt` then surfaces a clear error in
/// the transcript rather than the window failing to open.
fn build_state() -> AppState {
    // Desktop renders blueprints in-app; suppress the CLI's system-browser open.
    std::env::set_var("AGENTJ_DESKTOP", "1");

    let root = repo_root();
    let app_cfg = AppConfig::load(&root);
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
    let system = prompt::system_prompt(&root, company.as_deref());

    // A fresh interactive session so save_artifact/read_artifact (plan/todos/blueprint) work.
    let store = Arc::new(Store::mint(&root, None).expect("mint session store"));
    let jobs = jobs::JobManager::new(root.clone());
    let tools = tools::Tools::with_session(PathBuf::from(&root), jobs, None, Some(store.clone()));

    let sess = Session {
        llm: Arc::new(llm),
        tools: Arc::new(tools),
        cfg: Arc::new(run_cfg),
    };

    AppState {
        sess,
        store,
        messages: Arc::new(Mutex::new(vec![ChatMessage::system(system)])),
        turn: Arc::new(Mutex::new(None)),
        running: Arc::new(AtomicBool::new(false)),
    }
}

/// Start (or continue) a turn. Appends the user prompt, runs `run_turn` on a task, and forwards
/// every event to the webview. Rejects if a turn is already running.
#[tauri::command]
fn send_prompt(prompt: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("a turn is already running".into());
    }
    let messages = state.messages.clone();
    let sess = state.sess.clone();
    let store = state.store.clone();
    let running = state.running.clone();

    // Seed this turn's history: current conversation + the new user message.
    let mut msgs = {
        let mut g = messages.lock().unwrap();
        g.push(ChatMessage::user(prompt));
        g.clone()
    };

    let (tx, mut rx) = unbounded_channel::<AgentEvent>();

    // Forwarder: relay events to the UI; on a saved html artifact, hand its html over for the pane.
    let app_fwd = app.clone();
    let fwd = tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = app_fwd.emit("agent-event", &ev);
            if let AgentEvent::Artifact { name, format } = &ev {
                if format == "html" {
                    if let Some(html) = store.read_artifact(name) {
                        let _ = app_fwd.emit(
                            "blueprint",
                            BlueprintPayload { name: name.clone(), html },
                        );
                    }
                }
            }
        }
    });

    let handle = tauri::async_runtime::spawn(async move {
        let _ = agent::run_turn(&sess, &mut msgs, &tx, true, None).await;
        drop(tx); // end the forwarder
        let _ = fwd.await;
        *messages.lock().unwrap() = msgs; // persist history for the next turn
        running.store(false, Ordering::SeqCst);
    });
    *state.turn.lock().unwrap() = Some(handle);
    Ok(())
}

/// Abort the in-flight turn (if any). History keeps whatever committed before the abort.
#[tauri::command]
fn interrupt(state: State<'_, AppState>) {
    if let Some(h) = state.turn.lock().unwrap().take() {
        h.abort();
    }
    state.running.store(false, Ordering::SeqCst);
}

/// Read a named session artifact (feeds the blueprint pane / lets the UI re-open one).
#[tauri::command]
fn read_artifact(name: String, state: State<'_, AppState>) -> Option<String> {
    state.store.read_artifact(&name)
}

fn main() {
    tauri::Builder::default()
        .manage(build_state())
        .invoke_handler(tauri::generate_handler![send_prompt, interrupt, read_artifact])
        .run(tauri::generate_context!())
        .expect("error while running agentj-desktop");
}
