//! Async messages folded into `App` state: [`UiMsg`]s from the turn task ([`App::on_ui`] /
//! [`App::on_agent`]), the animation tick, and `/task` re-key begin/apply.

use super::tray::strip_tok_suffix;
use super::{App, AppEffect, SubagentRow, UiMsg, EFFECT_TTL};
use crate::events::AgentEvent;
use crate::provider::ChatMessage;
use crate::rekey::RekeyResult;
use crate::tui::theme;
use crate::tui::view::{assistant_block, dim_line, fmt_ms, tool_end_line};
use ratatui::text::{Line, Span};
use std::time::Instant;
use tachyonfx::{fx, Interpolation};

impl App {
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
        // conversation is now moot. The wipe must persist as a rewrite (not an append), else a
        // resume would resurrect the pre-re-key conversation.
        self.pending_interrupt_note = false;
        self.messages = vec![ChatMessage::system(self.system.clone())];
        self.history_reset = true;
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
            // Applied directly in the event loop (it rebuilds the session); never reaches here.
            UiMsg::McpAuthDone { .. } => AppEffect::None,
            UiMsg::McpReconnected { .. } => AppEffect::None,
        }
    }

    pub(super) fn on_agent(&mut self, ev: AgentEvent) {
        // Auto-scroll (Ctrl-P toggle): any content-bearing event re-pins the transcript to the tail.
        if self.auto_follow
            && matches!(
                ev,
                AgentEvent::Message(_)
                    | AgentEvent::ToolEnd { .. }
                    | AgentEvent::Note(_)
                    | AgentEvent::Error(_)
                    | AgentEvent::StepLimit(_)
            )
        {
            self.follow = true;
        }
        match ev {
            AgentEvent::Message(t) => {
                // agentj's reply as a card: a blank band row above and below pads it.
                use crate::tui::view::LineKind;
                self.transcript.push_kind(Line::default(), LineKind::Assistant);
                self.transcript.extend_kind(assistant_block(&t), LineKind::Assistant);
                self.transcript.push_kind(Line::default(), LineKind::Assistant);
                self.set_effect("new reply");
            }
            AgentEvent::ToolStart { name, args, step } => {
                self.current_tool_batched = self.last_tool_step == Some(step);
                self.last_tool_step = Some(step);
                self.current_tool = format!("{name}({args})");
                // The subagent panel is the live status for run_subagents; don't overwrite it.
                if name != "run_subagents" {
                    self.status = self.current_tool.clone();
                }
                // The status timer tracks the CURRENT step, not the whole turn — otherwise a long
                // turn reads "thinking · 271s" and looks wedged when it's healthy.
                self.since = Instant::now();
                self.set_effect(format!("tool: {name}"));
            }
            AgentEvent::ToolEnd {
                ok,
                summary,
                elapsed_ms,
                ..
            } => {
                // A finished run_subagents collapses the agent tray into permanent transcript
                // summaries; its own summary is redundant with those per-agent ✓/✗ lines.
                let is_delegate = self.current_tool.starts_with("run_subagents(");
                if is_delegate {
                    self.flush_subagent_summaries();
                }
                let shown = if is_delegate { "" } else { summary.as_str() };
                self.transcript.push_kind(
                    tool_end_line(&self.current_tool, ok, elapsed_ms, shown, self.current_tool_batched),
                    crate::tui::view::LineKind::Tool,
                );
                self.status = "thinking".to_string();
                self.since = Instant::now(); // per-step timer: time in THIS thinking stretch
                self.set_effect(format!("done in {}", fmt_ms(elapsed_ms)));
            }
            AgentEvent::SubagentStart { id, desc, .. } => {
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
                        tokens_in: 0,
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
                // Keep the row in the rail with its outcome; the frozen block lands in the
                // transcript when the whole wave joins (flush_subagent_summaries).
                if let Some(row) = self.subagents.get_mut(&id) {
                    row.done = Some(ok);
                    row.final_ms = Some(elapsed_ms);
                    if !summary.trim().is_empty() {
                        // The " · N tok" suffix is for the headless/eval stream; the rail carries
                        // its own live token meter, so showing both would duplicate it.
                        row.status = strip_tok_suffix(&summary).to_string();
                    }
                }
                self.dirty = true;
            }
            AgentEvent::Usage(u) => {
                self.last_usage = Some(u);
                self.tokens.add_primary(&u);
                self.dirty = true;
            }
            AgentEvent::SubagentUsage { id, usage } => {
                self.tokens.add_sub(&usage);
                if let Some(row) = self.subagents.get_mut(&id) {
                    row.tokens_in += usage.prompt_tokens;
                }
                self.dirty = true;
            }
            AgentEvent::Thinking(t) => {
                // The model's reasoning as its own dim `thinking` block — plain (no assistant
                // glyph); the transcript wraps long lines and the type label marks the block.
                use crate::tui::view::LineKind;
                for line in t.lines() {
                    self.transcript.push_kind(dim_line(line.to_string()), LineKind::Thinking);
                }
                self.set_effect("thinking");
                self.dirty = true;
            }
            AgentEvent::Note(t) => {
                let line = dim_line(format!("» {t}"));
                self.transcript.push_kind(line, crate::tui::view::LineKind::Note);
                self.dirty = true;
            }
            // The save already shows as a tool line in the TUI; the Artifact signal is for the
            // desktop app (which refreshes its live todos view).
            AgentEvent::Artifact { .. } => {}
            AgentEvent::StepLimit(n) => {
                self.step_limit_hit = true;
                self.transcript.push(dim_line(format!(
                    "» step gate: hit the {n}-step budget — press Enter (empty prompt) to continue, or type new directions"
                )));
                self.set_effect("step gate — Enter continues");
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
                // Steps restart at 0 next turn — without this, its first call could read as batched.
                self.last_tool_step = None;
                self.set_effect("all set");
            }
        }
    }
}
