//! Interactive full-screen ratatui chat: a transcript / status / input layout driven by an event loop
//! over three sources (a 120ms animation ticker, terminal input from a reader thread, and agent events
//! from the turn task). State and transitions live in `app`; rendering in `view`.

mod app;
mod wrap;
mod editor;
mod keymap;
mod knowledge;
mod markdown;
mod theme;
mod view;

use crate::agent::{run_turn, Session};
use crate::config::AppConfig;
use crate::events::AgentEvent;
use crate::model::{preflight, resolve_model, Selector};
use crate::provider::{ChatMessage, Llm};
use crate::rekey::rekey;
use app::{App, AppEffect, TurnHandle, UiMsg};
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::style::Print;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use keymap::KEYBOARD_FLAGS;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::time::interval;

/// Spawn a turn over the current committed history (which already ends with the new user message).
/// Forwards agent events as `UiMsg::Agent` and committed message deltas as `UiMsg::HistoryDelta`, then
/// sends `TurnDone`. Returns a `TurnHandle` (abort handle + job watermark) so Ctrl-C can cancel the
/// turn and kill the background jobs it started.
fn spawn_turn(history: &[ChatMessage], sess: Session, ui: UnboundedSender<UiMsg>) -> TurnHandle {
    let job_watermark = sess.tools.jobs.id_watermark();
    let mut msgs = history.to_vec();
    let handle = tokio::spawn(async move {
        let (atx, mut arx) = unbounded_channel::<AgentEvent>();
        let (ctx, mut crx) = unbounded_channel::<Vec<ChatMessage>>();
        let ui_ev = ui.clone();
        let drain_events = async move {
            while let Some(ev) = arx.recv().await {
                let _ = ui_ev.send(UiMsg::Agent(ev));
            }
        };
        let ui_delta = ui.clone();
        let drain_deltas = async move {
            while let Some(delta) = crx.recv().await {
                let _ = ui_delta.send(UiMsg::HistoryDelta(delta));
            }
        };
        let run = async {
            let _ = run_turn(&sess, &mut msgs, &atx, true, Some(&ctx)).await;
            drop(atx); // close the channels so the drains finish
            drop(ctx);
        };
        tokio::join!(run, drain_events, drain_deltas);
        let _ = ui.send(UiMsg::TurnDone);
    });
    TurnHandle {
        abort: handle.abort_handle(),
        job_watermark,
    }
}

/// Diff the tree against the stored knowledge index. `Ok((changes, unchanged_count))`, or a
/// user-facing message when the diff can't run.
async fn knowledge_changes(root: &str) -> Result<(knowledge::Changes, usize), String> {
    let Some(manifest) = knowledge::load_manifest(root) else {
        return Err("no knowledge index yet — run /init first".to_string());
    };
    let files = knowledge::tracked_files(root)
        .await
        .map_err(|e| e.to_string())?;
    let current = knowledge::hash_files(root, &files);
    let changes = knowledge::diff_manifest(&manifest.files, &current);
    let unchanged = current.len() - changes.added.len() - changes.modified.len();
    Ok((changes, unchanged))
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    provider: String,
    model_id: String,
    root: String,
    system: String,
    app_cfg: AppConfig,
    sess: Session,
    mcp_status: Vec<crate::mcp::client::McpStatus>,
    needs_setup: bool,
) -> anyhow::Result<()> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    // Mouse capture IS enabled: agentj runs its own transcript selection (click-drag with
    // auto-scroll, copy via OSC 52), which needs the drag/scroll events capture delivers. This
    // supersedes the terminal's native selection (users can still fall back with Shift/Option in most
    // terminals).
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableBracketedPaste,
        EnableMouseCapture
    )?;
    // Ask for progressive keyboard reporting so modified Enter/Esc are distinguishable where the
    // terminal supports it (kitty/ghostty/wezterm/newer iTerm2), and chords like Cmd/Ctrl+Backspace
    // are surfaced distinctly instead of collapsing to a plain Backspace byte on PTYs.
    let _ = execute!(stdout, PushKeyboardEnhancementFlags(KEYBOARD_FLAGS));
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let mut app = App::new(
        &provider,
        &model_id,
        root.clone(),
        system,
        sess.cfg.context_window,
        mcp_status,
        needs_setup,
    );
    let mut sess = sess;
    let mut app_cfg = app_cfg; // reloaded from disk after the setup wizard writes a provider block

    let (ui_tx, mut ui_rx) = unbounded_channel::<UiMsg>();
    let (in_tx, mut in_rx) = unbounded_channel::<Event>();
    std::thread::spawn(move || {
        while let Ok(ev) = crossterm::event::read() {
            if in_tx.send(ev).is_err() {
                break;
            }
        }
    });
    let mut ticker = interval(Duration::from_millis(120));

    while !app.quit {
        if app.dirty {
            let width = terminal.size()?.width;
            app.refresh_input(width);
            terminal.draw(|f| view::draw(f, &mut app))?;
            app.dirty = false;
        }

        tokio::select! {
            _ = ticker.tick() => {
                app.on_tick(Instant::now());
                // Refresh the running-jobs snapshot for the activity panel (and keep redrawing so the
                // elapsed times tick even when no turn is running).
                if sess.tools.jobs.has_running() || !app.jobs.is_empty() {
                    app.jobs = sess.tools.jobs.running_snapshot().await;
                    app.dirty = true;
                }
                // Autonomous continuation: when idle, a finished background job wakes a turn to act
                // on its result (drained inside run_turn) instead of waiting for the next user prompt.
                if !app.running && app.turn.is_none() && sess.tools.jobs.has_nudges() {
                    app.begin_running("continuing — a background job finished");
                    app.turn = Some(spawn_turn(&app.messages, sess.clone(), ui_tx.clone()));
                }
            }
            Some(ev) = in_rx.recv() => {
                let mut pending = vec![ev];
                while let Ok(ev) = in_rx.try_recv() {
                    pending.push(ev);
                }
                for ev in pending {
                    match app.on_input(ev) {
                        AppEffect::None => {}
                        AppEffect::Quit => app.quit = true,
                        AppEffect::SwitchModel { provider, selector } => {
                            let model_override = selector.model.as_deref();
                            let sel = Selector {
                                provider,
                                model: model_override,
                                base_url: None,
                            };
                            match preflight(&sel, &app_cfg)
                                .and_then(|_| resolve_model(&sel, &app_cfg))
                                .and_then(|cfg| {
                                    let llm = Llm::from_config(&cfg).map_err(|e| e.to_string())?;
                                    let run_cfg = crate::config::Config::from_sources(&cfg.model_id, &app_cfg);
                                    Ok((cfg, llm, run_cfg))
                                })
                            {
                                Ok((cfg, llm, run_cfg)) => {
                                    app.provider = provider.as_str().to_string();
                                    app.model_id = cfg.model_id.clone();
                                    app.context_window = run_cfg.context_window;
                                    app.notice(format!(
                                        "switched to provider/model: {}/{}",
                                        app.provider, app.model_id
                                    ));
                                    sess = Session {
                                        llm: std::sync::Arc::new(llm),
                                        tools: sess.tools.clone(),
                                        cfg: std::sync::Arc::new(run_cfg),
                                    };
                                }
                                Err(e) => app.notice(format!("couldn't switch provider/model: {e}")),
                            }
                        }
                        AppEffect::SpawnTurn => {
                            app.turn =
                                Some(spawn_turn(&app.messages, sess.clone(), ui_tx.clone()));
                        }
                        AppEffect::Rekey { reference, desc } => {
                            // Run the (blocking, network-bound) worktree re-key off the event loop so
                            // the UI stays live — a spinner and "re-keying →" status instead of a
                            // frozen screen. The result comes back as UiMsg::RekeyDone.
                            app.begin_rekey(&reference);
                            let root = app.root.clone();
                            let tx = ui_tx.clone();
                            tokio::spawn(async move {
                                let rk = rekey(&root, &reference).await;
                                let _ = tx.send(UiMsg::RekeyDone { rk, desc });
                            });
                        }
                        AppEffect::KillJobsAfter(watermark) => {
                            sess.tools.jobs.kill_after(watermark).await;
                        }
                        AppEffect::Init => {
                            match knowledge::write_boilerplate_config(&app.root, &app.model_id) {
                                Ok(true) => app.notice("created .aj/aj.json"),
                                Ok(false) => {}
                                Err(e) => app.notice(format!("couldn't write .aj/aj.json: {e}")),
                            }
                            app.start_command_turn(
                                knowledge::init_directive(),
                                "mapping the codebase",
                            );
                            app.turn =
                                Some(spawn_turn(&app.messages, sess.clone(), ui_tx.clone()));
                        }
                        AppEffect::Knowledge => {
                            match knowledge_changes(&app.root).await {
                                Err(e) => app.notice(e),
                                Ok((changes, unchanged)) if changes.is_empty() => {
                                    app.notice(format!(
                                        "docs are in sync — {unchanged} files unchanged since the last snapshot"
                                    ));
                                }
                                Ok((changes, unchanged)) => {
                                    app.notice(format!(
                                        "since the last snapshot: {} added · {} modified · {} removed",
                                        changes.added.len(),
                                        changes.modified.len(),
                                        changes.removed.len(),
                                    ));
                                    app.start_command_turn(
                                        knowledge::knowledge_directive(&changes, unchanged),
                                        "syncing the docs",
                                    );
                                    app.turn = Some(spawn_turn(
                                        &app.messages,
                                        sess.clone(),
                                        ui_tx.clone(),
                                    ));
                                }
                            }
                        }
                        // on_input never yields Snapshot; it comes from TurnDone below.
                        AppEffect::Snapshot => {}
                        AppEffect::Copy(text) => {
                            // OSC 52: hand the selection to the terminal's clipboard (local or over
                            // SSH). Bypasses ratatui — write it straight to the backend.
                            let _ = execute!(terminal.backend_mut(), Print(osc52_copy(&text)));
                            app.notice(format!("copied {} chars", text.chars().count()));
                        }
                        AppEffect::McpLogin(name) => {
                            let configs = crate::mcp::config::load_mcp_servers(&app.root);
                            match configs.iter().find(|c| c.name == name).and_then(|c| c.url.clone()) {
                                None => app.notice(format!(
                                    "no http/sse MCP server named `{name}` — /mcp for the list"
                                )),
                                Some(url) => {
                                    app.notice(format!("authorizing {name}…"));
                                    let tx = ui_tx.clone();
                                    let n = name.clone();
                                    tokio::spawn(async move {
                                        let progress = tx.clone();
                                        let result = crate::mcp::oauth::login(&url, move |m| {
                                            let _ = progress.send(UiMsg::Agent(
                                                crate::events::AgentEvent::Note(m),
                                            ));
                                        })
                                        .await
                                        .map_err(|e| e.to_string());
                                        let _ = tx.send(UiMsg::McpAuthDone { name: n, result });
                                    });
                                }
                            }
                        }
                        AppEffect::McpLogout(name) => {
                            let configs = crate::mcp::config::load_mcp_servers(&app.root);
                            match configs.iter().find(|c| c.name == name).and_then(|c| c.url.clone()) {
                                Some(url) => {
                                    crate::mcp::oauth::forget(&url);
                                    app.notice(format!("{name}: cached credentials removed"));
                                }
                                None => app.notice(format!("no http/sse MCP server named `{name}`")),
                            }
                        }
                        AppEffect::ConfigureProvider(setup) => {
                            // Persist to the global config, reload it, then reuse the normal
                            // build-and-swap path so the new provider is live with no restart.
                            match crate::config::write_provider_config(
                                setup.provider.as_str(),
                                &setup.model,
                                &setup.base_url,
                                &setup.api_key,
                                None, // the Foundry /openai/v1 endpoint needs no api-version
                            ) {
                                Ok(path) => {
                                    app_cfg = AppConfig::load(&root);
                                    let sel = Selector {
                                        provider: setup.provider,
                                        model: Some(&setup.model),
                                        base_url: None,
                                    };
                                    match preflight(&sel, &app_cfg)
                                        .and_then(|_| resolve_model(&sel, &app_cfg))
                                        .and_then(|cfg| {
                                            let llm = Llm::from_config(&cfg)
                                                .map_err(|e| e.to_string())?;
                                            let run_cfg = crate::config::Config::from_sources(
                                                &cfg.model_id,
                                                &app_cfg,
                                            );
                                            Ok((cfg, llm, run_cfg))
                                        }) {
                                        Ok((cfg, llm, run_cfg)) => {
                                            app.provider = setup.provider.as_str().to_string();
                                            app.model_id = cfg.model_id.clone();
                                            app.context_window = run_cfg.context_window;
                                            app.finish_setup(format!(
                                                "saved to {} — ready ({}/{})",
                                                path.display(),
                                                app.provider,
                                                app.model_id
                                            ));
                                            sess = Session {
                                                llm: std::sync::Arc::new(llm),
                                                tools: sess.tools.clone(),
                                                cfg: std::sync::Arc::new(run_cfg),
                                            };
                                        }
                                        Err(e) => app.setup_failed(format!("that didn't work — {e}")),
                                    }
                                }
                                Err(e) => app.setup_failed(format!("couldn't write config: {e}")),
                            }
                        }
                    }
                    if app.quit {
                        break;
                    }
                }
            }
            Some(msg) = ui_rx.recv() => {
                let mut pending = vec![msg];
                while let Ok(msg) = ui_rx.try_recv() {
                    pending.push(msg);
                }
                for msg in pending {
                    // A finished re-key applies its result here (it may start a turn, which needs the
                    // loop's sess/ui_tx that on_ui can't reach).
                    if let UiMsg::RekeyDone { rk, desc } = msg {
                        if let AppEffect::SpawnTurn = app.apply_rekey_result(rk, desc) {
                            app.turn = Some(spawn_turn(&app.messages, sess.clone(), ui_tx.clone()));
                        }
                        continue;
                    }
                    // A server was just authorized: reconnect MCP off-loop so the UI stays live, then
                    // swap the fresh clients into the session below.
                    if let UiMsg::McpAuthDone { name, result } = msg {
                        match result {
                            Err(e) => app.notice(format!("{name}: authorization failed — {e}")),
                            Ok(()) => {
                                app.notice(format!("{name} authorized — reconnecting MCP servers…"));
                                sess.tools.shutdown_mcp();
                                let root = app.root.clone();
                                let tx = ui_tx.clone();
                                tokio::spawn(async move {
                                    let configs = crate::mcp::config::load_mcp_servers(&root);
                                    let (clients, statuses) =
                                        crate::mcp::client::connect_all(&configs).await;
                                    let _ = tx.send(UiMsg::McpReconnected { clients, statuses });
                                });
                            }
                        }
                        continue;
                    }
                    if let UiMsg::McpReconnected { clients, statuses } = msg {
                        let tool_count = clients.tool_count();
                        app.mcp_status = statuses;
                        sess = Session {
                            llm: sess.llm.clone(),
                            tools: std::sync::Arc::new(crate::tools::Tools::with_session(
                                std::path::PathBuf::from(&app.root),
                                sess.tools.jobs.clone(),
                                Some(std::sync::Arc::new(clients)),
                                sess.tools.session.clone(), // keep the session across an MCP reconnect
                            )),
                            cfg: sess.cfg.clone(),
                        };
                        app.notice(format!("MCP reconnected — {tool_count} tools available"));
                        continue;
                    }
                    if matches!(app.on_ui(msg), AppEffect::Snapshot) {
                        match knowledge::snapshot(&app.root).await {
                            Ok(n) => app.notice(format!("knowledge index updated — {n} files hashed")),
                            Err(e) => app.notice(format!("knowledge snapshot failed: {e}")),
                        }
                    }
                }
            }
        }
    }

    let _ = execute!(terminal.backend_mut(), PopKeyboardEnhancementFlags);
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen,
        DisableBracketedPaste
    )?;
    disable_raw_mode()?;
    Ok(())
}

/// Wrap text in an OSC 52 clipboard-write sequence (`c` = the CLIPBOARD selection), terminated with
/// BEL. Terminals that support OSC 52 (kitty, iTerm2, wezterm, tmux with `set-clipboard on`, …) copy
/// it — including over SSH, unlike a local clipboard command.
fn osc52_copy(text: &str) -> String {
    format!("\x1b]52;c;{}\x07", base64_encode(text.as_bytes()))
}

/// Minimal standard base64 (RFC 4648) so OSC 52 needs no dependency.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | b2 as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"hello world"), "aGVsbG8gd29ybGQ=");
    }
}
