//! The UI state and the pure(ish) state transitions that drive it. Keystrokes and agent events are
//! folded into `App` here; anything that must `.await` (spawning a turn, `/task` re-key) is deferred to
//! the event loop in `mod.rs` via an `AppEffect` the handler returns.

use super::editor::Editor;
use super::keymap::{key_to_action, Action};
use super::theme;
use super::view::{assistant_block, dim_line, fmt_ms, tool_end_line, InputLayoutCache, TranscriptView};
use crate::commands::{fuzzy_commands, SlashCommand, SLASH_COMMANDS};
use crate::events::AgentEvent;
use crate::jobs::JobInfo;
use crate::mcp::client::McpStatus;
use crate::model::{Provider, SelectorOverride};
use crate::provider::{ChatMessage, TokenUsage};
use crate::rekey::{is_linked_worktree, RekeyResult};
use crossterm::event::{Event, KeyEvent, KeyEventKind, MouseButton, MouseEventKind};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use tachyonfx::{fx, Effect, Interpolation};
use tokio::task::AbortHandle;

const EFFECT_TTL: Duration = Duration::from_millis(700);
/// A second Ctrl-C within this window quits.
const DOUBLE_TAP: Duration = Duration::from_secs(2);

const CHEAT_SHEET: &str = "Enter send · Ctrl-J newline · Esc interrupt · / commands · ↑↓/wheel or PageUp/Dn scroll · Ctrl-C×2 quit";

/// Orients the model after an interrupt: side effects (edits, commits) may already have applied.
/// Deferred to the head of the next turn so any history deltas the aborted turn already queued land
/// in front of it.
const INTERRUPT_NOTE: &str =
    "[note: the previous request was interrupted by the user; some tool actions may have already applied]";

/// The slash token containing the cursor, when the completion popover should consider it: a maximal
/// non-whitespace run ending at the cursor that starts with `/` at the start of the text or right
/// after whitespace (so `a/b` or a mid-word `/` never triggers). Returns (start byte, token so far).
fn slash_token(text: &str, cursor: usize) -> Option<(usize, String)> {
    let before = &text[..cursor];
    let start = before
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    let token = &before[start..];
    if token.starts_with('/') {
        Some((start, token.to_string()))
    } else {
        None
    }
}

/// The slash-command completion popover: fuzzy matches for the token being typed.
pub struct Popover {
    pub items: Vec<&'static SlashCommand>,
    pub selected: usize,
    /// Byte offset where the token starts (replaced on accept).
    token_start: usize,
}

/// Messages from the turn task into the UI event loop.
pub enum UiMsg {
    Agent(AgentEvent),
    /// Newly committed history — an assistant reply, a tool-call group, or a nudge — appended as the
    /// turn progresses so an interrupt keeps whatever already applied.
    HistoryDelta(Vec<ChatMessage>),
    /// The turn task finished (natural completion or clean stop).
    TurnDone,
    /// A `/task` re-key finished off-thread; carries its result and the task directive to start.
    RekeyDone { rk: RekeyResult, desc: String },
}

/// A running turn: its abort handle plus the job-id watermark captured at spawn, so an interrupt can
/// kill exactly the background jobs this turn started.
pub struct TurnHandle {
    pub abort: AbortHandle,
    pub job_watermark: u64,
}

/// One subagent's row in the tray shown while a delegate batch runs. Finished rows stay in the tray
/// (with their outcome) until the whole batch completes, so checkmarks visibly accumulate.
pub struct SubagentRow {
    pub desc: String,
    /// Latest progress line; after completion, the final result summary.
    pub status: String,
    pub started: Instant,
    /// Progress events seen — the per-agent activity counter.
    pub steps: u64,
    /// When the last progress event arrived (drives the brief activity flash).
    pub last_activity: Instant,
    /// `Some(ok)` once the subagent finished.
    pub done: Option<bool>,
    /// Elapsed frozen at completion.
    pub final_ms: Option<u64>,
}

/// Work the event loop must perform after a state transition (it needs `.await` or the turn task's
/// handles, which `App` doesn't own).
pub enum AppEffect {
    None,
    Quit,
    /// Switch the active provider/model for future turns.
    SwitchModel {
        provider: Provider,
        selector: SelectorOverride,
    },
    /// Spawn a turn from the current committed history; the loop stores the handle in `App::turn`.
    SpawnTurn,
    /// Run a `/task` re-key, then feed the result back via `apply_rekey_result`.
    Rekey { reference: String, desc: String },
    /// SIGKILL background jobs started at or after this watermark (an interrupted turn's jobs).
    KillJobsAfter(u64),
    /// `/init`: write boilerplate config, then start the orchestrated mapping turn.
    Init,
    /// `/knowledge`: diff the tree against the knowledge index, then start a doc-sync turn.
    Knowledge,
    /// A snapshot-tracked turn finished cleanly — rebuild the knowledge index.
    Snapshot,
    /// First-run setup: persist a provider to the global config and build a live client from it.
    ConfigureProvider(ProviderSetup),
    /// Copy this text to the system clipboard (emitted via OSC 52 by the event loop).
    Copy(String),
}

/// A drag selection in absolute SCREEN cells (col, row). Screen-based rather than tied to the
/// transcript data model, so it can cover ANY rendered content — the transcript, a modal, a panel.
/// The text is read back from the rendered terminal buffer (`App::screen_rows`).
#[derive(Clone, Copy)]
pub struct Selection {
    pub anchor: (u16, u16),
    pub cursor: (u16, u16),
}

impl Selection {
    /// (top-left, bottom-right) endpoints ordered by (row, col).
    pub fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        let key = |p: (u16, u16)| (p.1, p.0);
        if key(self.anchor) <= key(self.cursor) {
            (self.anchor, self.cursor)
        } else {
            (self.cursor, self.anchor)
        }
    }
    pub fn is_click(&self) -> bool {
        self.anchor == self.cursor
    }
}

/// The transcript's top screen row and height from the last frame, so a drag past its top/bottom
/// edge can auto-scroll while selecting.
#[derive(Clone, Copy)]
pub struct TranscriptGeom {
    pub y: u16,
    pub viewport: u16,
}

/// Values collected by the setup wizard, handed to the event loop to persist + build a client.
#[derive(Clone, Debug)]
pub struct ProviderSetup {
    pub provider: Provider,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SetupStep {
    Provider,
    BaseUrl,
    ApiKey,
    Model,
}

/// The guided first-run provider setup, rendered as a modal form. Collects one field per Enter; the
/// ApiKey step masks input. `error` holds the last validation message, shown in the modal.
pub struct SetupWizard {
    pub step: SetupStep,
    pub provider: Option<Provider>,
    pub base_url: String,
    pub api_key: String,
    pub error: Option<String>,
}

pub struct App {
    // context for building turns / re-keying
    pub system: String,
    pub root: String,
    pub provider: String,
    pub model_id: String,
    // conversation
    pub messages: Vec<ChatMessage>,
    pub transcript: TranscriptView,
    // input
    pub editor: Editor,
    pub input_cache: InputLayoutCache,
    pub popover: Option<Popover>,
    /// Token the user dismissed with Esc — stays closed until the token changes.
    popover_dismissed: Option<String>,
    // turn state
    pub running: bool,
    pub turn: Option<TurnHandle>,
    pub since: Instant,
    pub status: String,
    pub current_tool: String,
    /// Rebuild the knowledge index when this turn completes cleanly (/init and /knowledge turns).
    pub pending_snapshot: bool,
    /// The current turn hit a hard error — a pending snapshot is skipped so a failed doc run
    /// doesn't mark everything as documented.
    turn_saw_error: bool,
    /// An aborted turn owes an interrupt note; it is pushed at the start of the next turn so any
    /// history deltas the aborted turn already queued land before it.
    pending_interrupt_note: bool,
    // live subagents (delegate batch), keyed by index for stable ordering
    pub subagents: BTreeMap<usize, SubagentRow>,
    /// Snapshot of running background jobs, refreshed each tick for the activity panel.
    pub jobs: Vec<JobInfo>,
    /// A brief coalesce effect over the tray when a batch spins up (tachyonfx).
    pub tray_fx: Option<Effect>,
    /// Previous frame time, for effect delta timing (owned by `view::draw`).
    pub last_draw: Option<Instant>,
    // session status meter
    pub session_start: Instant,
    pub last_usage: Option<TokenUsage>,
    pub context_window: Option<u64>,
    // animation / effects
    pub spinner: usize,
    pub pulse: usize,
    pub effect_until: Option<Instant>,
    pub effect_label: String,
    pub last_effect_active: bool,
    pub last_ctrl_c: Option<Instant>,
    // scroll
    pub scroll: u16,
    pub follow: bool,
    // selection (screen-cell based; text read back from the rendered buffer)
    pub selection: Option<Selection>,
    pub selecting: bool,
    pub tgeom: Option<TranscriptGeom>,
    /// The last rendered frame's text, one String per screen row, captured while a selection is
    /// active so copy can read exactly what's on screen (any widget, not just the transcript).
    pub screen_rows: Vec<String>,
    // loop control
    pub dirty: bool,
    pub quit: bool,
    /// The first-run provider setup wizard, while it's active.
    pub setup: Option<SetupWizard>,
    /// Per-server MCP connect results, shown in a dismissible startup modal.
    pub mcp_status: Vec<McpStatus>,
    pub show_mcp_modal: bool,
}

impl App {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider: &str,
        model_id: &str,
        root: String,
        system: String,
        context_window: Option<u64>,
        mcp_status: Vec<McpStatus>,
        needs_setup: bool,
    ) -> Self {
        let transcript = TranscriptView::new(vec![dim_line(CHEAT_SHEET)]);
        // Surface MCP failures as a dismissible modal (below), not as transcript noise.
        let show_mcp_modal = mcp_status.iter().any(|s| s.outcome.is_err());
        let mut app = Self {
            system: system.clone(),
            root,
            provider: provider.to_string(),
            model_id: model_id.to_string(),
            messages: vec![ChatMessage::system(system)],
            transcript,
            editor: Editor::default(),
            input_cache: InputLayoutCache::default(),
            popover: None,
            popover_dismissed: None,
            running: false,
            turn: None,
            since: Instant::now(),
            status: String::new(),
            current_tool: String::new(),
            pending_snapshot: false,
            turn_saw_error: false,
            pending_interrupt_note: false,
            subagents: BTreeMap::new(),
            jobs: Vec::new(),
            tray_fx: None,
            last_draw: None,
            session_start: Instant::now(),
            last_usage: None,
            context_window,
            spinner: 0,
            pulse: 0,
            effect_until: None,
            effect_label: String::new(),
            last_effect_active: false,
            last_ctrl_c: None,
            scroll: 0,
            follow: true,
            selection: None,
            selecting: false,
            tgeom: None,
            screen_rows: Vec::new(),
            dirty: true,
            quit: false,
            setup: None,
            mcp_status,
            show_mcp_modal,
        };
        if needs_setup {
            app.start_setup();
        }
        app
    }

    /// True while the MCP status modal should be shown (and no setup wizard is in front of it).
    pub fn mcp_modal_open(&self) -> bool {
        self.show_mcp_modal && self.setup.is_none()
    }

    pub fn refresh_input(&mut self, width: u16) {
        self.input_cache.refresh(&self.editor, width);
    }

    /// Open the guided provider-setup modal at the first field.
    pub fn start_setup(&mut self) {
        self.editor.clear();
        self.setup = Some(SetupWizard {
            step: SetupStep::Provider,
            provider: None,
            base_url: String::new(),
            api_key: String::new(),
            error: None,
        });
        self.dirty = true;
    }

    /// Cancel the wizard (Esc). Leaves the session unconfigured; `/setup` reopens it.
    pub fn cancel_setup(&mut self) -> AppEffect {
        self.setup = None;
        self.editor.clear();
        self.notice("setup canceled — run /setup to configure a provider");
        AppEffect::None
    }

    /// Feed one submitted field into the wizard, advancing a step or (on the last) emitting the effect
    /// that persists the config and builds the client. Validation messages go into `error` for the
    /// modal to show; nothing touches the transcript.
    fn advance_setup(&mut self, line: &str) -> AppEffect {
        let line = line.trim().to_string();
        let Some(w) = self.setup.as_mut() else {
            return AppEffect::None;
        };
        self.dirty = true;
        w.error = None;
        match w.step {
            SetupStep::Provider => {
                let provider = match line.to_lowercase().as_str() {
                    "1" | "azure" => Provider::Azure,
                    "2" | "custom" => Provider::Custom,
                    _ => {
                        w.error = Some("pick 1 (azure) or 2 (custom)".into());
                        return AppEffect::None;
                    }
                };
                w.provider = Some(provider);
                w.step = SetupStep::BaseUrl;
            }
            SetupStep::BaseUrl => {
                if line.is_empty() {
                    w.error = Some("the base URL can't be empty".into());
                    return AppEffect::None;
                }
                w.base_url = line;
                w.step = SetupStep::ApiKey;
            }
            SetupStep::ApiKey => {
                w.api_key = line;
                w.step = SetupStep::Model;
            }
            SetupStep::Model => {
                if line.is_empty() {
                    w.error = Some("the model can't be empty".into());
                    return AppEffect::None;
                }
                return AppEffect::ConfigureProvider(ProviderSetup {
                    provider: w.provider.unwrap_or(Provider::Custom),
                    base_url: w.base_url.clone(),
                    api_key: w.api_key.clone(),
                    model: line,
                });
            }
        }
        AppEffect::None
    }

    /// The wizard succeeded: close the modal and confirm.
    pub fn finish_setup(&mut self, msg: impl Into<String>) {
        self.setup = None;
        self.editor.clear();
        self.notice(msg.into());
    }

    /// The wizard's values didn't produce a working client: reopen at the first field with the error.
    pub fn setup_failed(&mut self, msg: impl Into<String>) {
        self.start_setup();
        if let Some(w) = self.setup.as_mut() {
            w.error = Some(msg.into());
        }
    }

    pub fn effect_active(&self) -> bool {
        self.effect_until.is_some_and(|until| until > Instant::now())
    }

    /// Collapse the agent tray: every finished subagent gets a permanent ✓/✗ summary line in the
    /// transcript (still-running rows just vanish — their turn was aborted). Called when a delegate
    /// batch completes, and on turn end/abort as a safety net.
    fn flush_subagent_summaries(&mut self) {
        self.tray_fx = None;
        for (id, row) in std::mem::take(&mut self.subagents) {
            let Some(ok) = row.done else { continue };
            let (glyph, style) = if ok {
                ("✓", theme::ok())
            } else {
                ("✗", theme::err())
            };
            let mut spans = vec![
                Span::styled(format!("{glyph} "), style),
                Span::styled(format!("[{id}] {}", row.desc), theme::muted()),
            ];
            if let Some(ms) = row.final_ms {
                spans.push(Span::styled(format!(" — {}", fmt_ms(ms as u128)), theme::dim()));
            }
            if !row.status.trim().is_empty() {
                spans.push(Span::styled(format!(" · {}", row.status), theme::dim()));
            }
            self.transcript.push(Line::from(spans));
        }
        self.dirty = true;
    }

    /// A dim `»` note line in the transcript (lifecycle chatter, not conversation content).
    pub fn notice(&mut self, s: impl Into<String>) {
        self.transcript.push(dim_line(format!("» {}", s.into())));
        self.dirty = true;
    }

    /// Start a directive-driven turn (`/init`, `/knowledge`): the visible echo was already pushed
    /// by submit; the actual user message is the full directive. The knowledge index is rebuilt
    /// when this turn completes cleanly.
    pub fn start_command_turn(&mut self, directive: String, effect_label: &str) {
        self.flush_interrupt_note();
        self.messages.push(ChatMessage::user(directive));
        self.pending_snapshot = true;
        self.turn_saw_error = false;
        self.follow = true;
        self.begin_running(effect_label.to_string());
    }

    /// Common turn-start bookkeeping: mark the turn running, reset the elapsed clock and status line,
    /// and flash the given effect label.
    pub fn begin_running(&mut self, effect_label: impl Into<String>) {
        self.running = true;
        self.since = Instant::now();
        self.status.clear();
        self.set_effect(effect_label);
    }

    /// Push the deferred interrupt note, if an earlier turn was aborted. Called at the head of the next
    /// turn so the aborted turn's already-queued history deltas land in front of it.
    fn flush_interrupt_note(&mut self) {
        if std::mem::take(&mut self.pending_interrupt_note) {
            self.messages.push(ChatMessage::user(INTERRUPT_NOTE));
        }
    }

    /// Push a user prompt line, preceded by a blank line to separate turns visually.
    fn push_user_line(&mut self, text: &str) {
        self.transcript.push(Line::default());
        self.transcript.push(Line::from(vec![
            Span::styled("› ", theme::accent()),
            Span::styled(text.to_string(), Style::default().add_modifier(Modifier::BOLD)),
        ]));
    }

    fn set_effect(&mut self, label: impl Into<String>) {
        self.effect_until = Some(Instant::now() + EFFECT_TTL);
        self.effect_label = label.into();
        self.last_effect_active = true;
        self.dirty = true;
    }

    /// Advance the spinner/pulse animation and expire a finished effect. Only animates when there's
    /// something to animate, so an idle UI never repaints.
    pub fn on_tick(&mut self, now: Instant) {
        let effect_active = self.effect_until.is_some_and(|until| until > now);
        let had_effect = self.last_effect_active;
        if self.running || effect_active || had_effect {
            self.spinner = self.spinner.wrapping_add(1);
            self.pulse = self.pulse.wrapping_add(1);
            if self.effect_until.is_some_and(|until| until <= now) {
                self.effect_until = None;
                self.effect_label.clear();
            }
            self.last_effect_active = self.effect_until.is_some_and(|until| until > now);
            self.dirty = true;
        }
    }

    /// When a drag reaches the transcript's top/bottom edge, scroll it one row so the selection can
    /// extend beyond the viewport — and shift the anchor to track its text (until it scrolls off).
    /// Only when no modal is up (modals are static and cover the transcript).
    fn autoscroll_selection(&mut self, row: u16) {
        if self.setup.is_some() || self.mcp_modal_open() {
            return;
        }
        let Some(g) = self.tgeom else { return };
        let bottom = g.y + g.viewport.saturating_sub(1);
        let delta: i32 = if row <= g.y {
            -1
        } else if row >= bottom {
            1
        } else {
            return;
        };
        self.follow = false;
        self.scroll = if delta < 0 {
            self.scroll.saturating_sub(1)
        } else {
            self.scroll.saturating_add(1)
        };
        // Content moved by `delta`; keep the anchor on the same text if it's within the transcript.
        if let Some(sel) = self.selection.as_mut() {
            let (ax, ay) = sel.anchor;
            if ay >= g.y && ay <= bottom {
                let ny = (ay as i32 - delta).clamp(g.y as i32, bottom as i32) as u16;
                sel.anchor = (ax, ny);
            }
        }
    }

    /// The selected text, read from the last rendered frame's screen rows so it's exactly what's on
    /// screen (any widget). Rows join with newlines; trailing padding is trimmed.
    pub fn selected_screen_text(&self, sel: Selection) -> String {
        let ((sx, sy), (ex, ey)) = sel.ordered();
        let mut out: Vec<String> = Vec::new();
        for y in sy..=ey {
            let chars: Vec<char> = self
                .screen_rows
                .get(y as usize)
                .map(|s| s.chars().collect())
                .unwrap_or_default();
            let x0 = if y == sy { sx as usize } else { 0 };
            let x1 = if y == ey { ex as usize } else { chars.len() };
            let x0 = x0.min(chars.len());
            let x1 = x1.min(chars.len()).max(x0);
            out.push(chars[x0..x1].iter().collect::<String>().trim_end().to_string());
        }
        out.join("\n")
    }

    pub fn on_input(&mut self, ev: Event) -> AppEffect {
        match ev {
            Event::Paste(s) if !self.running => {
                self.editor.insert_str(&s);
                self.update_popover();
                self.dirty = true;
                AppEffect::None
            }
            Event::Mouse(m) => {
                match m.kind {
                    MouseEventKind::ScrollUp => {
                        self.follow = false;
                        self.scroll = self.scroll.saturating_sub(3);
                        self.dirty = true;
                    }
                    MouseEventKind::ScrollDown => {
                        self.scroll = self.scroll.saturating_add(3);
                        self.dirty = true;
                    }
                    MouseEventKind::Down(MouseButton::Left) => {
                        // Anchor a selection at the clicked screen cell. Works over ANY content —
                        // transcript, modals, panels. A bare click (no drag) clears on release.
                        let cell = (m.column, m.row);
                        self.selection = Some(Selection { anchor: cell, cursor: cell });
                        self.selecting = true;
                        self.dirty = true;
                    }
                    MouseEventKind::Drag(MouseButton::Left) if self.selecting => {
                        self.autoscroll_selection(m.row); // scroll if dragging past the transcript edge
                        if let Some(sel) = self.selection.as_mut() {
                            sel.cursor = (m.column, m.row);
                        }
                        self.dirty = true;
                    }
                    MouseEventKind::Up(MouseButton::Left) if self.selecting => {
                        self.selecting = false;
                        self.dirty = true;
                        match self.selection {
                            Some(sel) if !sel.is_click() => {
                                let text = self.selected_screen_text(sel);
                                if !text.is_empty() {
                                    return AppEffect::Copy(text);
                                }
                            }
                            // a click with no drag: clear the highlight (does NOT dismiss a modal)
                            _ => self.selection = None,
                        }
                    }
                    _ => {}
                }
                AppEffect::None
            }
            Event::Resize(_, _) => {
                self.dirty = true;
                AppEffect::None
            }
            Event::Key(k) if k.kind != KeyEventKind::Release => self.on_key(k),
            _ => AppEffect::None,
        }
    }

    fn on_key(&mut self, k: KeyEvent) -> AppEffect {
        // The MCP status modal is informational — any key dismisses it and is consumed.
        if self.mcp_modal_open() {
            self.show_mcp_modal = false;
            self.dirty = true;
            return AppEffect::None;
        }
        // While the setup modal is open, Esc cancels it (rather than interrupting a turn); typing and
        // Enter fall through to the editor/submit, which routes into the wizard.
        if self.setup.is_some()
            && k.modifiers.is_empty()
            && k.code == crossterm::event::KeyCode::Esc
        {
            return self.cancel_setup();
        }
        // The popover captures navigation/accept/dismiss keys before the normal keymap.
        if self.popover.is_some() && !self.running && k.modifiers.is_empty() {
            match k.code {
                crossterm::event::KeyCode::Up => return self.popover_move(-1),
                crossterm::event::KeyCode::Down => return self.popover_move(1),
                crossterm::event::KeyCode::Tab | crossterm::event::KeyCode::Enter => {
                    return self.popover_accept()
                }
                crossterm::event::KeyCode::Esc => return self.popover_dismiss(),
                _ => {}
            }
        }
        match key_to_action(k, self.running, self.editor.text()) {
            Action::None => AppEffect::None,
            Action::Quit => AppEffect::Quit,
            Action::ClearInput => self.edit(|e| e.clear()),
            Action::Char(c) => self.edit(|e| e.insert_char(c)),
            Action::Newline => self.edit(|e| e.insert_char('\n')),
            Action::Backspace => self.edit(|e| e.backspace()),
            Action::Delete => self.edit(|e| e.delete()),
            Action::DeleteWordLeft => self.edit(|e| e.delete_word_left()),
            Action::DeleteWordRight => self.edit(|e| e.delete_word_right()),
            Action::DeleteToLineHome => self.edit(|e| e.delete_to_line_home()),
            Action::DeleteToLineEnd => self.edit(|e| e.delete_to_line_end()),
            Action::Left => self.edit(|e| e.left()),
            Action::Right => self.edit(|e| e.right()),
            Action::WordLeft => self.edit(|e| e.word_left()),
            Action::WordRight => self.edit(|e| e.word_right()),
            // Single-line input: ↑/↓ scroll the transcript (what mouse wheels send under
            // alternate-scroll); multi-line input: they move the cursor between lines.
            Action::Up if !self.editor.text().contains('\n') => self.scroll_by(-1, true),
            Action::Down if !self.editor.text().contains('\n') => self.scroll_by(1, false),
            Action::Up => self.edit(|e| e.up()),
            Action::Down => self.edit(|e| e.down()),
            Action::Home => self.edit(|e| e.home()),
            Action::End => self.edit(|e| e.end()),
            Action::ScrollUp => self.scroll_by(-1, true),
            Action::ScrollDown => self.scroll_by(1, false),
            Action::PageUp => self.scroll_by(-10, true),
            Action::PageDown => self.scroll_by(10, false),
            Action::Complete => {
                // Tab with no popover open: try to open it for the token under the cursor.
                self.update_popover();
                self.dirty = true;
                AppEffect::None
            }
            Action::AbortTurn => self.abort_turn(),
            Action::CtrlC => self.ctrl_c(),
            Action::Submit(text) => self.submit(text),
        }
    }

    fn edit(&mut self, f: impl FnOnce(&mut Editor)) -> AppEffect {
        f(&mut self.editor);
        self.update_popover();
        self.dirty = true;
        AppEffect::None
    }

    /// Recompute the popover from the token under the cursor. Opens on a `/` token (at start or
    /// after whitespace), filters by fuzzy match, closes when nothing matches or the token is gone.
    fn update_popover(&mut self) {
        let Some((start, token)) = slash_token(self.editor.text(), self.editor.cursor()) else {
            self.popover = None;
            self.popover_dismissed = None;
            return;
        };
        if self.popover_dismissed.as_deref() == Some(token.as_str()) {
            self.popover = None;
            return;
        }
        self.popover_dismissed = None;
        let items = fuzzy_commands(&token, SLASH_COMMANDS);
        if items.is_empty() {
            self.popover = None;
            return;
        }
        let selected = self
            .popover
            .as_ref()
            .map(|p| p.selected.min(items.len() - 1))
            .unwrap_or(0);
        self.popover = Some(Popover {
            items,
            selected,
            token_start: start,
        });
    }

    fn popover_move(&mut self, delta: i32) -> AppEffect {
        if let Some(p) = &mut self.popover {
            let n = p.items.len() as i32;
            p.selected = ((p.selected as i32 + delta).rem_euclid(n)) as usize;
            self.dirty = true;
        }
        AppEffect::None
    }

    fn popover_accept(&mut self) -> AppEffect {
        if let Some(p) = self.popover.take() {
            let cmd = p.items[p.selected];
            let insert = if cmd.takes_arg {
                format!("{} ", cmd.name)
            } else {
                cmd.name.to_string()
            };
            self.editor
                .replace_range(p.token_start, self.editor.cursor(), &insert);
            // Stay closed for the accepted token (else a no-arg command like /exit would keep
            // reopening and Enter could never submit); any further edit reopens it.
            self.popover_dismissed =
                slash_token(self.editor.text(), self.editor.cursor()).map(|(_, t)| t);
            self.dirty = true;
        }
        AppEffect::None
    }

    fn popover_dismiss(&mut self) -> AppEffect {
        if let Some((_, token)) = slash_token(self.editor.text(), self.editor.cursor()) {
            self.popover_dismissed = Some(token);
        }
        self.popover = None;
        self.dirty = true;
        AppEffect::None
    }

    fn scroll_by(&mut self, delta: i32, break_follow: bool) -> AppEffect {
        if break_follow {
            self.follow = false;
        }
        self.scroll = if delta < 0 {
            self.scroll.saturating_sub((-delta) as u16)
        } else {
            self.scroll.saturating_add(delta as u16)
        };
        self.dirty = true;
        AppEffect::None
    }

    fn abort_turn(&mut self) -> AppEffect {
        self.running = false;
        self.status.clear();
        self.pending_snapshot = false; // an interrupted doc run must not stamp the index
        self.flush_subagent_summaries();
        self.transcript.push(dim_line("[interrupted]"));
        self.follow = true;
        self.set_effect("interrupted");
        match self.turn.take() {
            Some(t) => {
                t.abort.abort();
                // Defer the orientation note to the next turn so history deltas still queued in the ui
                // channel are appended ahead of it (else the note would jump in front of them).
                self.pending_interrupt_note = true;
                AppEffect::KillJobsAfter(t.job_watermark)
            }
            None => AppEffect::None,
        }
    }

    fn ctrl_c(&mut self) -> AppEffect {
        let now = Instant::now();
        if self.last_ctrl_c.is_some_and(|t| now.duration_since(t) < DOUBLE_TAP) {
            AppEffect::Quit // second Ctrl-C within the window → quit
        } else {
            self.last_ctrl_c = Some(now);
            self.editor.clear(); // first Ctrl-C also clears any typed input
            self.effect_until = Some(now + DOUBLE_TAP);
            self.effect_label = "press Ctrl-C again to quit".to_string();
            self.last_effect_active = true;
            self.dirty = true;
            AppEffect::None
        }
    }

    fn submit(&mut self, text: String) -> AppEffect {
        self.editor.clear();
        self.update_popover();
        self.follow = true;
        self.dirty = true;
        if self.setup.is_some() {
            // In the setup wizard every line is an answer (including a blank key), so route before the
            // empty/command checks below.
            return self.advance_setup(&text);
        }
        if text.is_empty() {
            AppEffect::None
        } else if text == "/exit" || text == "/quit" {
            AppEffect::Quit
        } else if text == "/setup" {
            self.start_setup();
            AppEffect::None
        } else if text == "/init" {
            self.push_user_line(&text);
            AppEffect::Init
        } else if text == "/knowledge" {
            self.push_user_line(&text);
            AppEffect::Knowledge
        } else if text == "/model" || text.starts_with("/model ") {
            self.submit_model(&text)
        } else if text == "/task" || text.starts_with("/task ") {
            self.submit_task(&text)
        } else {
            self.push_user_line(&text);
            self.flush_interrupt_note();
            self.messages.push(ChatMessage::user(text));
            self.begin_running("let's cook");
            AppEffect::SpawnTurn
        }
    }

    fn submit_model(&mut self, text: &str) -> AppEffect {
        self.push_user_line(text);
        let rest = text["/model".len()..].trim();
        if rest.is_empty() {
            self.transcript.push(dim_line(format!(
                "usage: /model <provider> [model]  (current: {} / {})",
                self.provider, self.model_id
            )));
            return AppEffect::None;
        }
        if self.running {
            self.transcript.push(dim_line(
                "» wait for the current turn to finish before switching provider/model",
            ));
            return AppEffect::None;
        }
        let mut parts = rest.split_whitespace();
        let provider_name = parts.next().unwrap_or_default();
        let Some(provider) = Provider::parse(provider_name) else {
            self.transcript.push(dim_line(format!(
                "» unknown provider `{provider_name}`; expected one of: vertex, anthropic, azure, custom"
            )));
            return AppEffect::None;
        };
        let model = parts.collect::<Vec<_>>().join(" ");
        AppEffect::SwitchModel {
            provider,
            selector: SelectorOverride {
                model: (!model.is_empty()).then_some(model),
            },
        }
    }

    fn submit_task(&mut self, text: &str) -> AppEffect {
        let rest = text["/task".len()..].trim().to_string();
        let reference = rest.split_whitespace().next().unwrap_or("").to_string();
        if reference.is_empty() {
            self.transcript.push(dim_line(
                "usage: /task <pr-number | branch-name> [task description]",
            ));
            AppEffect::None
        } else if !is_linked_worktree(&self.root)
            && std::env::var("AGENTJ_ALLOW_PRIMARY").as_deref() != Ok("1")
        {
            self.transcript.push(dim_line("» /task does a destructive reset to origin and is meant for a dedicated worktree — this looks like the primary checkout. Run agentj in your worktree, or set AGENTJ_ALLOW_PRIMARY=1."));
            AppEffect::None
        } else {
            self.transcript
                .push(dim_line(format!("» re-keying worktree → {reference}")));
            // A bare `/task <ref>` (no inline description) should still start the work after re-keying,
            // not just switch branches and idle. Synthesize a directive from the reference so the agent
            // fetches the task and implements it.
            let desc = rest[reference.len()..].trim().to_string();
            let desc = if desc.is_empty() {
                format!(
                    "Work on `{reference}` end to end. First find out what it requires — `{reference}` \
                     looks like a tracker issue, so fetch its details from a connected issue tracker \
                     (e.g. Linear via MCP) or infer the goal from the branch and its recent commits. \
                     Then scope, plan, implement, and verify your work."
                )
            } else {
                desc
            };
            AppEffect::Rekey { reference, desc }
        }
    }

    /// Fold a completed `/task` re-key into state. Returns `SpawnTurn` when a task description should
    /// start a turn, else `None`.
    /// Enter the re-keying busy state (spinner + status) while the worktree switch runs off the event
    /// loop, so the UI stays live instead of freezing on the blocking git work.
    pub fn begin_rekey(&mut self, reference: &str) {
        self.running = true;
        self.since = Instant::now();
        self.status = format!("re-keying → {reference}");
        self.set_effect("re-keying");
        self.dirty = true;
    }

    pub fn apply_rekey_result(&mut self, rk: RekeyResult, desc: String) -> AppEffect {
        // Leave the re-keying busy state; the turn path below re-enters `running` via begin_running.
        self.running = false;
        self.status.clear();
        for s in &rk.steps {
            self.transcript.push(dim_line(format!("  · {s}")));
        }
        if !rk.ok {
            self.transcript.push(dim_line(format!(
                "» re-key failed: {}",
                rk.error.unwrap_or_default()
            )));
            self.set_effect("re-key failed");
            return AppEffect::None;
        }
        let branch = rk.branch.unwrap_or_default();
        self.transcript
            .push(dim_line(format!("» clean on {branch}, synced to origin")));
        // A re-key wipes history for the new worktree, so a deferred interrupt note from the old
        // conversation is now moot.
        self.pending_interrupt_note = false;
        self.messages = vec![ChatMessage::system(self.system.clone())];
        if desc.is_empty() {
            self.set_effect(format!("switched to {branch}"));
            AppEffect::None
        } else {
            self.push_user_line(&desc);
            self.messages.push(ChatMessage::user(desc));
            self.begin_running(format!("switched to {branch}"));
            AppEffect::SpawnTurn
        }
    }

    pub fn on_ui(&mut self, msg: UiMsg) -> AppEffect {
        match msg {
            UiMsg::Agent(ev) => {
                self.on_agent(ev);
                AppEffect::None
            }
            UiMsg::HistoryDelta(delta) => {
                self.messages.extend(delta);
                AppEffect::None
            }
            UiMsg::TurnDone => {
                self.running = false;
                self.status.clear();
                self.turn = None;
                self.flush_subagent_summaries();
                if self.effect_label.is_empty() {
                    self.effect_until = Some(Instant::now() + EFFECT_TTL);
                    self.effect_label = "all set".to_string();
                    self.last_effect_active = true;
                }
                self.dirty = true;
                if self.pending_snapshot {
                    self.pending_snapshot = false;
                    if self.turn_saw_error {
                        self.notice("skipping the knowledge snapshot — the run hit an error");
                        AppEffect::None
                    } else {
                        AppEffect::Snapshot
                    }
                } else {
                    AppEffect::None
                }
            }
            // Applied directly in the event loop (it may start a turn); never reaches here.
            UiMsg::RekeyDone { .. } => AppEffect::None,
        }
    }

    fn on_agent(&mut self, ev: AgentEvent) {
        match ev {
            AgentEvent::Message(t) => {
                self.transcript.extend(assistant_block(&t));
                self.set_effect("new reply");
            }
            AgentEvent::ToolStart { name, args, .. } => {
                self.current_tool = format!("{name}({args})");
                // The subagent panel is the live status for delegate; don't overwrite it.
                if name != "delegate" {
                    self.status = self.current_tool.clone();
                }
                self.set_effect(format!("tool: {name}"));
            }
            AgentEvent::ToolEnd {
                ok,
                summary,
                elapsed_ms,
                ..
            } => {
                // A finished delegate collapses the agent tray into permanent transcript summaries;
                // its own summary is redundant with those per-agent ✓/✗ lines.
                let is_delegate = self.current_tool.starts_with("delegate(");
                if is_delegate {
                    self.flush_subagent_summaries();
                }
                let shown = if is_delegate { "" } else { summary.as_str() };
                self.transcript
                    .push(tool_end_line(&self.current_tool, ok, elapsed_ms, shown));
                self.status = "thinking".to_string();
                self.set_effect(format!("done in {}", fmt_ms(elapsed_ms)));
            }
            AgentEvent::SubagentStart { id, desc } => {
                let now = Instant::now();
                if self.subagents.is_empty() {
                    // The tray materializes: cells coalesce into place over ~a quarter second.
                    self.tray_fx = Some(fx::coalesce((250, Interpolation::SineOut)));
                }
                self.subagents.insert(
                    id,
                    SubagentRow {
                        desc,
                        status: "starting".to_string(),
                        started: now,
                        steps: 0,
                        last_activity: now,
                        done: None,
                        final_ms: None,
                    },
                );
                self.dirty = true;
            }
            AgentEvent::SubagentProgress { id, status } => {
                if let Some(row) = self.subagents.get_mut(&id) {
                    row.status = status;
                    row.steps += 1;
                    row.last_activity = Instant::now();
                }
                self.dirty = true;
            }
            AgentEvent::SubagentEnd {
                id,
                ok,
                summary,
                elapsed_ms,
            } => {
                // Keep the row in the tray with its outcome; the transcript summary lands when the
                // whole batch collapses (flush_subagent_summaries).
                if let Some(row) = self.subagents.get_mut(&id) {
                    row.done = Some(ok);
                    row.final_ms = Some(elapsed_ms);
                    if !summary.trim().is_empty() {
                        row.status = summary;
                    }
                }
                self.dirty = true;
            }
            AgentEvent::Usage(u) => {
                self.last_usage = Some(u);
                self.dirty = true;
            }
            AgentEvent::Note(t) => {
                self.transcript.push(dim_line(format!("» {t}")));
                self.dirty = true;
            }
            AgentEvent::Error(e) => {
                self.turn_saw_error = true;
                self.transcript
                    .push(Line::from(Span::styled(format!("✗ {e}"), theme::err())));
                self.set_effect("error");
            }
            AgentEvent::Done => {
                self.running = false;
                self.status.clear();
                self.set_effect("all set");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers, MouseButton, MouseEvent};

    fn app() -> App {
        App::new("vertex", "dummy", ".".to_string(), "sys".to_string(), None, Vec::new(), false)
    }

    fn mouse(kind: MouseEventKind) -> Event {
        Event::Mouse(MouseEvent {
            kind,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        })
    }

    #[test]
    fn selected_screen_text_reads_the_rendered_rows_across_lines() {
        let mut a = app();
        // Simulate a rendered frame (what's on screen), including trailing padding to trim.
        a.screen_rows = vec![
            "  hello world      ".to_string(),
            "  second line      ".to_string(),
        ];
        // Drag from (4,0) to (8,1): row 0 from col 4 to end, row 1 from col 0 to col 8 (linear
        // selection, so the last row includes its leading indent).
        let sel = Selection { anchor: (4, 0), cursor: (8, 1) };
        assert_eq!(a.selected_screen_text(sel), "llo world\n  second");
        // reversed drag → same range
        let rev = Selection { anchor: (8, 1), cursor: (4, 0) };
        assert_eq!(a.selected_screen_text(rev), "llo world\n  second");
        // single row selection past the text trims trailing spaces
        let one = Selection { anchor: (2, 0), cursor: (19, 0) };
        assert_eq!(a.selected_screen_text(one), "hello world");
    }

    #[test]
    fn autoscroll_selection_scrolls_and_keeps_the_anchor_on_its_text() {
        let mut a = app();
        a.tgeom = Some(TranscriptGeom { y: 0, viewport: 10 }); // transcript rows 0..=9
        a.scroll = 5;
        a.selection = Some(Selection { anchor: (3, 4), cursor: (3, 9) });
        // drag to the bottom edge (row 9) → scroll down one, anchor shifts up to track its text
        a.autoscroll_selection(9);
        assert_eq!(a.scroll, 6);
        assert!(!a.follow);
        assert_eq!(a.selection.unwrap().anchor, (3, 3));
        // dragging in the middle does nothing
        a.autoscroll_selection(5);
        assert_eq!(a.scroll, 6);
    }

    #[test]
    fn mouse_wheel_scrolls_transcript() {
        let mut a = app();
        a.scroll = 5;
        a.follow = true;

        a.on_input(mouse(MouseEventKind::ScrollUp));
        assert_eq!(a.scroll, 2);
        assert!(!a.follow);

        let before = a.follow;
        a.on_input(mouse(MouseEventKind::ScrollDown));
        assert_eq!(a.scroll, 5);
        assert_eq!(a.follow, before);
        // a non-scroll mouse event is a no-op
        a.on_input(mouse(MouseEventKind::Down(MouseButton::Left)));
        assert_eq!(a.scroll, 5);
    }

    #[test]
    fn setup_wizard_collects_details_then_emits_configure() {
        let mut a = app();
        a.start_setup();
        assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::Provider);
        // a bad provider choice stays put
        assert!(matches!(a.advance_setup("nonsense"), AppEffect::None));
        assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::Provider);
        // walk the happy path
        assert!(matches!(a.advance_setup("2"), AppEffect::None));
        assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::BaseUrl);
        assert!(matches!(a.advance_setup("http://localhost:8080/v1"), AppEffect::None));
        assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::ApiKey);
        assert!(matches!(a.advance_setup("sk-123"), AppEffect::None));
        assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::Model);
        match a.advance_setup("gpt-4.1") {
            AppEffect::ConfigureProvider(s) => {
                assert_eq!(s.provider, Provider::Custom);
                assert_eq!(s.base_url, "http://localhost:8080/v1");
                assert_eq!(s.api_key, "sk-123");
                assert_eq!(s.model, "gpt-4.1");
            }
            _ => panic!("last step should emit ConfigureProvider"),
        }
    }

    #[test]
    fn wizard_submit_is_not_treated_as_a_turn_or_command() {
        let mut a = app();
        a.start_setup();
        a.editor.insert_str("azure");
        let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::None), "wizard input never spawns a turn");
        assert!(!a.running);
        assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::BaseUrl);
    }

    #[test]
    fn bare_task_reference_synthesizes_a_directive_so_work_starts() {
        let mut a = app();
        std::env::set_var("AGENTJ_ALLOW_PRIMARY", "1"); // bypass the worktree guard in the test
        let effect = a.submit_task("/task GEN-3300");
        std::env::remove_var("AGENTJ_ALLOW_PRIMARY");
        match effect {
            AppEffect::Rekey { reference, desc } => {
                assert_eq!(reference, "GEN-3300");
                assert!(!desc.is_empty(), "a bare /task must still produce a task directive");
                assert!(desc.contains("GEN-3300"), "directive references the task");
            }
            _ => panic!("expected a Rekey effect that carries a directive"),
        }
        // An explicit description is passed through unchanged.
        let effect = {
            std::env::set_var("AGENTJ_ALLOW_PRIMARY", "1");
            let e = a.submit_task("/task GEN-3300 fix the login bug");
            std::env::remove_var("AGENTJ_ALLOW_PRIMARY");
            e
        };
        match effect {
            AppEffect::Rekey { desc, .. } => assert_eq!(desc, "fix the login bug"),
            _ => panic!("expected Rekey"),
        }
    }

    #[test]
    fn submit_plain_text_starts_a_turn() {
        let mut a = app();
        a.editor.insert_str("hello");
        let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::SpawnTurn));
        assert!(a.running);
        assert!(a.editor.text().is_empty());
        // the user message is committed to history up front (spawn_turn clones it)
        assert!(a
            .messages
            .iter()
            .any(|m| m.role == "user" && m.content.as_deref() == Some("hello")));
    }

    #[tokio::test]
    async fn abort_defers_interrupt_marker_behind_queued_deltas() {
        let mut a = app();
        let abort = tokio::spawn(std::future::pending::<()>()).abort_handle();
        a.turn = Some(TurnHandle {
            abort,
            job_watermark: 7,
        });
        a.running = true;
        let effect = a.abort_turn();
        assert!(matches!(effect, AppEffect::KillJobsAfter(7)));
        assert!(!a.running);
        // The note is NOT pushed at abort time — deltas the aborted turn already queued land first.
        assert!(!a.messages.iter().any(|m| m
            .content
            .as_deref()
            .is_some_and(|c| c.contains("interrupted by the user"))));

        // A late history delta from the aborted turn arrives, then the user sends the next message.
        a.on_ui(UiMsg::HistoryDelta(vec![ChatMessage::user("late delta")]));
        a.editor.insert_str("next");
        a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        let idx = |needle: &str| {
            a.messages
                .iter()
                .position(|m| m.content.as_deref().is_some_and(|c| c.contains(needle)))
                .unwrap_or_else(|| panic!("missing {needle}"))
        };
        // History order: late delta, then the interrupt note, then the new user message.
        assert!(idx("late delta") < idx("interrupted by the user"));
        assert!(idx("interrupted by the user") < idx("next"));
    }

    fn type_str(a: &mut App, s: &str) {
        for c in s.chars() {
            a.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
    }

    #[test]
    fn slash_popover_opens_filters_and_accepts() {
        let mut a = app();
        type_str(&mut a, "/");
        let p = a.popover.as_ref().expect("popover opens on /");
        assert_eq!(p.items.len(), SLASH_COMMANDS.len());

        // fuzzy-filters as you type
        type_str(&mut a, "ta");
        let p = a.popover.as_ref().unwrap();
        assert_eq!(p.items[0].name, "/task");

        // Enter accepts the selection instead of submitting
        let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::None));
        assert_eq!(a.editor.text(), "/task ");
        assert!(!a.running);
        assert!(a.popover.is_none());
    }

    #[test]
    fn accepting_a_no_arg_command_lets_the_next_enter_submit() {
        let mut a = app();
        type_str(&mut a, "/ex");
        // First Enter accepts the completion…
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            AppEffect::None
        ));
        assert_eq!(a.editor.text(), "/exit");
        assert!(a.popover.is_none(), "popover must stay closed after accept");
        // …the second Enter submits (here: /exit quits).
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            AppEffect::Quit
        ));
    }

    #[test]
    fn slash_popover_works_mid_input_but_not_mid_word() {
        let mut a = app();
        type_str(&mut a, "see ");
        type_str(&mut a, "/ex");
        assert!(a.popover.is_some(), "slash after whitespace opens the popover");
        let effect = a.on_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::None));
        assert_eq!(a.editor.text(), "see /exit");

        let mut b = app();
        type_str(&mut b, "a/b");
        assert!(b.popover.is_none(), "slash glued to a word must not open the popover");
    }

    #[test]
    fn slash_popover_arrows_select_and_esc_dismisses_until_token_changes() {
        let mut a = app();
        type_str(&mut a, "/");
        a.on_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(a.popover.as_ref().unwrap().selected, 1);
        a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(a.popover.as_ref().unwrap().selected, 0);
        a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)); // wraps
        assert_eq!(a.popover.as_ref().unwrap().selected, SLASH_COMMANDS.len() - 1);

        // Esc closes it and keeps it closed for the same token…
        a.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(a.popover.is_none());
        assert!(!a.editor.text().is_empty(), "Esc dismisses the popover, not the input");
        // …but typing more reopens it.
        type_str(&mut a, "t");
        assert!(a.popover.is_some());
    }

    #[test]
    fn plain_up_down_scrolls_single_line_but_moves_cursor_in_multiline() {
        let mut a = app();
        type_str(&mut a, "hello");
        a.scroll = 5;
        a.follow = true;
        a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(a.scroll, 4, "single-line input: ↑ scrolls the transcript");
        assert!(!a.follow);

        let mut b = app();
        type_str(&mut b, "one");
        b.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));
        type_str(&mut b, "two");
        let before = b.scroll;
        b.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(b.scroll, before, "multi-line input: ↑ moves the cursor, not the scroll");
        assert!(b.editor.cursor() < b.editor.text().len());
    }

    fn transcript_text(a: &App) -> String {
        a.transcript.plain()
    }

    #[test]
    fn tray_collapses_into_transcript_summaries_when_the_delegate_batch_lands() {
        use crate::events::AgentEvent;
        let mut a = app();
        a.on_ui(UiMsg::Agent(AgentEvent::ToolStart {
            name: "delegate".to_string(),
            args: "{tasks:…}".to_string(),
        }));
        a.on_ui(UiMsg::Agent(AgentEvent::SubagentStart {
            id: 0,
            desc: "port the tests".to_string(),
        }));
        a.on_ui(UiMsg::Agent(AgentEvent::SubagentProgress {
            id: 0,
            status: "bash(cargo test)".to_string(),
        }));
        assert_eq!(a.subagents[&0].steps, 1);

        a.on_ui(UiMsg::Agent(AgentEvent::SubagentEnd {
            id: 0,
            ok: true,
            summary: "all 4 tests pass".to_string(),
            elapsed_ms: 2000,
        }));
        // Finished but batch still open: row pinned in the tray, no transcript summary yet.
        assert_eq!(a.subagents[&0].done, Some(true));
        assert!(!transcript_text(&a).contains("all 4 tests pass"));

        a.on_ui(UiMsg::Agent(AgentEvent::ToolEnd {
            ok: true,
            elapsed_ms: 2100,
            summary: "[subagent 0] …".to_string(),
        }));
        // Batch landed: tray empty, permanent ✓ summary in the transcript.
        assert!(a.subagents.is_empty());
        let t = transcript_text(&a);
        assert!(t.contains("✓ [0] port the tests"), "transcript: {t}");
        assert!(t.contains("all 4 tests pass"));
    }

    #[test]
    fn init_and_knowledge_commands_dispatch_their_effects() {
        let mut a = app();
        a.editor.insert_str("/init");
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            AppEffect::Init
        ));
        assert!(!a.running, "the turn starts only once the loop builds the directive");

        let mut b = app();
        b.editor.insert_str("/knowledge");
        assert!(matches!(
            b.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            AppEffect::Knowledge
        ));
    }

    #[test]
    fn command_turns_snapshot_on_clean_completion_only() {
        use crate::events::AgentEvent;

        // Clean run → TurnDone yields a Snapshot effect exactly once.
        let mut a = app();
        a.start_command_turn("directive".to_string(), "mapping");
        assert!(a.running && a.pending_snapshot);
        assert!(matches!(a.on_ui(UiMsg::TurnDone), AppEffect::Snapshot));
        assert!(!a.pending_snapshot);
        assert!(matches!(a.on_ui(UiMsg::TurnDone), AppEffect::None));

        // A turn that errored skips the snapshot.
        let mut b = app();
        b.start_command_turn("directive".to_string(), "mapping");
        b.on_ui(UiMsg::Agent(AgentEvent::Error("boom".to_string())));
        assert!(matches!(b.on_ui(UiMsg::TurnDone), AppEffect::None));

        // An aborted turn drops the pending snapshot.
        let mut c = app();
        c.start_command_turn("directive".to_string(), "mapping");
        c.abort_turn();
        assert!(!c.pending_snapshot);
        assert!(matches!(c.on_ui(UiMsg::TurnDone), AppEffect::None));

        // Ordinary turns never snapshot.
        let mut d = app();
        d.editor.insert_str("hello");
        d.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(d.on_ui(UiMsg::TurnDone), AppEffect::None));
    }

    #[test]
    fn exit_command_quits() {
        let mut a = app();
        a.editor.insert_str("/exit");
        let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(effect, AppEffect::Quit));
    }

    #[test]
    fn double_ctrl_c_quits_within_window() {
        let mut a = app();
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            AppEffect::None
        ));
        assert!(matches!(
            a.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            AppEffect::Quit
        ));
    }
}
