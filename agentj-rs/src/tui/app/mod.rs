//! The UI state and the pure(ish) state transitions that drive it. Keystrokes and agent events are
//! folded into `App` here; anything that must `.await` (spawning a turn, `/task` re-key) is deferred to
//! the event loop in `tui/mod.rs` via an `AppEffect` the handler returns.
//!
//! This file is the [`App`] state bundle itself: the struct, its constructor, and the small shared
//! helpers (notices, effect flashes, turn-start bookkeeping). Each concept lives in its own submodule:
//!  - `msg` — [`UiMsg`] (messages into the UI loop), [`AppEffect`] (deferred work out of it), and
//!    the running-turn [`TurnHandle`]
//!  - `input` — keyboard/mouse handling ([`App::on_input`]), the slash-command [`Popover`], and the
//!    Ctrl-P menu
//!  - `update` — folding [`UiMsg`]s into state ([`App::on_ui`]), the animation tick, and `/task`
//!    re-key results
//!  - `selection` — the screen-cell drag [`Selection`] and its copy read-back
//!  - `setup` — the first-run provider [`SetupWizard`]
//!  - `tokens` — cumulative [`SessionTokens`] accounting
//!  - `tray` — the live subagent tray ([`SubagentRow`]) and its frozen transcript summaries

mod input;
mod msg;
mod selection;
mod setup;
mod tokens;
mod tray;
mod update;

#[cfg(test)]
mod tests;

pub use input::Popover;
pub use msg::{AppEffect, TurnHandle, UiMsg};
pub use selection::{Selection, TranscriptGeom};
pub use setup::{ProviderSetup, SetupStep, SetupWizard};
pub use tokens::SessionTokens;
pub use tray::SubagentRow;

use super::editor::Editor;
use super::theme;
use super::view::{dim_line, InputLayoutCache, TranscriptView};
use crate::jobs::JobInfo;
use crate::mcp::client::McpStatus;
use crate::provider::{ChatMessage, TokenUsage};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use tachyonfx::Effect;

const EFFECT_TTL: Duration = Duration::from_millis(700);

const CHEAT_SHEET: &str = "Enter send · Ctrl-J newline · Esc interrupt · / commands · Ctrl-P menu · ↑↓/wheel or PageUp/Dn scroll · Ctrl-C×2 quit";

/// Orients the model after an interrupt: side effects (edits, commits) may already have applied.
/// Deferred to the head of the next turn so any history deltas the aborted turn already queued land
/// in front of it.
const INTERRUPT_NOTE: &str =
    "[note: the previous request was interrupted by the user; some tool actions may have already applied]";

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
    /// Round-trip the last ToolStart belonged to; a repeat means the model returned several calls
    /// in ONE response, and the transcript marks the followers `+`.
    last_tool_step: Option<usize>,
    current_tool_batched: bool,
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
    /// Cumulative token accounting for the whole session (primary loop + subagents).
    pub tokens: SessionTokens,
    /// Delegate waves joined so far this session — numbers the rail's join lines.
    pub waves: u64,
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
    /// Show supervisor nudges in the transcript (they always reach the model). Ctrl-P menu toggles.
    pub show_steering: bool,
    /// Re-pin the transcript to the tail whenever new activity lands (Ctrl-P toggle). Off by
    /// default: scrolling up stays put until you page back down or a new turn starts.
    pub auto_follow: bool,
    /// The Ctrl-P command menu: `Some(selected_index)` while open.
    pub menu: Option<usize>,
    /// The last turn ended at the step gate; an empty Enter continues it.
    pub step_limit_hit: bool,
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
        let show_mcp_modal = mcp_status
            .iter()
            .any(|s| !matches!(s.outcome, crate::mcp::client::McpOutcome::Ok(_)));
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
            last_tool_step: None,
            current_tool_batched: false,
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
            tokens: SessionTokens::default(),
            waves: 0,
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
            show_steering: true,
            auto_follow: false,
            menu: None,
            step_limit_hit: false,
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

    pub fn effect_active(&self) -> bool {
        self.effect_until.is_some_and(|until| until > Instant::now())
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
        self.step_limit_hit = false;
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
}
