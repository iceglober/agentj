//! User input: keyboard and mouse events folded into `App` state, the slash-command completion
//! [`Popover`], the Ctrl-P command menu, and the `/command` submit paths.

use super::{App, AppEffect, Selection};
use crate::commands::{fuzzy_commands, SlashCommand, SLASH_COMMANDS};
use crate::model::{Provider, SelectorOverride};
use crate::provider::ChatMessage;
use crate::rekey::is_linked_worktree;
use crate::tui::editor::Editor;
use crate::tui::keymap::{key_to_action, Action};
use crate::tui::view::dim_line;
use crossterm::event::{Event, KeyEvent, KeyEventKind, MouseButton, MouseEventKind};
use std::time::{Duration, Instant};

/// A second Ctrl-C within this window quits.
const DOUBLE_TAP: Duration = Duration::from_secs(2);

/// Split a `/task` argument into `(reference, task directive)`. A numeric or branch-shaped first
/// token (a digit, `-`, `/`, `_`, `.`) is a place to re-key ONTO — `1234`, `feature/login`,
/// `GEN-2827`. But a bare word followed by prose ("complete the project") is the TASK itself, not a
/// branch: we slug a fresh branch from it and keep the whole sentence as the directive, instead of
/// eating "complete" as a branch name. A single bare token stays a reference (it's a branch name).
pub(super) fn parse_task_args(rest: &str) -> (String, String) {
    let words: Vec<&str> = rest.split_whitespace().collect();
    let first = words.first().copied().unwrap_or("");
    let is_prose = words.len() > 1 && first.chars().all(|c| c.is_ascii_alphabetic());
    if is_prose {
        return (task_slug(rest), rest.to_string());
    }
    let reference = first.to_string();
    // A bare `/task <ref>` (no inline description) should still start the work after re-keying, not
    // switch branches and idle — synthesize a directive that fetches the task and implements it.
    let desc = rest[first.len()..].trim();
    let desc = if desc.is_empty() {
        format!(
            "Work on `{reference}` end to end. First find out what it requires — `{reference}` \
             looks like a tracker issue, so fetch its details from a connected issue tracker \
             (e.g. Linear via MCP) or infer the goal from the branch and its recent commits. \
             Then scope, plan, implement, and verify your work."
        )
    } else {
        desc.to_string()
    };
    (reference, desc)
}

/// A short, git-safe branch slug from a freeform task ("Complete the IV UX v2 project" →
/// "complete-the-iv-ux-v2"). Capped so branch names stay readable.
fn task_slug(task: &str) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for c in task.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            dash = false;
        } else if !slug.is_empty() && !dash {
            slug.push('-');
            dash = true;
        }
        if slug.len() >= 32 {
            break;
        }
    }
    match slug.trim_end_matches('-') {
        "" => "task".to_string(),
        s => s.to_string(),
    }
}

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

impl App {
    /// Ctrl-P command menu items: (label-builder handled in view) — order matters for menu_accept.
    pub const MENU_ITEMS: usize = 6;

    fn menu_move(&mut self, delta: i32) -> AppEffect {
        if let Some(sel) = self.menu.as_mut() {
            let n = Self::MENU_ITEMS as i32;
            *sel = ((*sel as i32 + delta).rem_euclid(n)) as usize;
            self.dirty = true;
        }
        AppEffect::None
    }

    fn menu_accept(&mut self) -> AppEffect {
        let Some(sel) = self.menu else {
            return AppEffect::None;
        };
        self.dirty = true;
        match sel {
            0 => {
                // Show/hide the model's `thinking` blocks. Display-only, retroactive.
                self.show_thinking = !self.show_thinking;
                self.transcript.set_hide_thinking(!self.show_thinking);
                AppEffect::None
            }
            1 => {
                // Auto-scroll: re-pin to the latest row whenever new activity lands. Stay open.
                self.auto_follow = !self.auto_follow;
                AppEffect::None
            }
            2 => {
                // Focus: hide the machinery (tool calls + thinking), leaving just the conversation
                // cards. Display-only, retroactive. Stay open so the change is visible.
                self.focus = !self.focus;
                self.transcript.set_focus(self.focus);
                AppEffect::None
            }
            3 => {
                // Export the transcript to a markdown file in the working dir.
                self.menu = None;
                match self.export_transcript() {
                    Ok(path) => self.notice(format!("exported transcript → {path}")),
                    Err(e) => self.notice(format!("transcript export failed: {e}")),
                }
                AppEffect::None
            }
            4 => {
                self.menu = None;
                self.show_mcp_modal = !self.mcp_status.is_empty();
                if self.mcp_status.is_empty() {
                    self.notice("no MCP servers configured (.mcp.json)");
                }
                AppEffect::None
            }
            _ => {
                self.menu = None;
                self.start_setup();
                AppEffect::None
            }
        }
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
                        self.selection = Some(Selection {
                            anchor: cell,
                            cursor: cell,
                        });
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

    pub(super) fn on_key(&mut self, k: KeyEvent) -> AppEffect {
        // The Ctrl-P command menu captures navigation while open (setup keeps priority over it).
        if self.menu.is_some() && self.setup.is_none() {
            use crossterm::event::KeyCode;
            match k.code {
                KeyCode::Up => return self.menu_move(-1),
                KeyCode::Down => return self.menu_move(1),
                KeyCode::Enter => return self.menu_accept(),
                KeyCode::Esc | KeyCode::Char('p')
                    if k.code == KeyCode::Esc
                        || k.modifiers
                            .contains(crossterm::event::KeyModifiers::CONTROL) =>
                {
                    self.menu = None;
                    self.dirty = true;
                    return AppEffect::None;
                }
                _ => return AppEffect::None, // modal: swallow other keys
            }
        }
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
                // Tab: open the slash-command completion popover for the token under the cursor.
                self.update_popover();
                self.dirty = true;
                AppEffect::None
            }
            Action::CommandMenu => {
                self.menu = if self.menu.is_some() { None } else { Some(0) };
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

    pub(super) fn abort_turn(&mut self) -> AppEffect {
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
        if self
            .last_ctrl_c
            .is_some_and(|t| now.duration_since(t) < DOUBLE_TAP)
        {
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
            // At the step gate, an empty Enter continues the turn (history is intact).
            if self.step_limit_hit && !self.running {
                self.step_limit_hit = false;
                self.push_user_line("continue");
                self.flush_interrupt_note();
                self.messages.push(ChatMessage::user(
                    "continue — pick up exactly where you left off; the step budget has reset",
                ));
                self.begin_running("continuing");
                return AppEffect::SpawnTurn;
            }
            AppEffect::None
        } else if text == "/exit" || text == "/quit" {
            AppEffect::Quit
        } else if text == "/setup" {
            self.start_setup();
            AppEffect::None
        } else if text == "/mcp" || text.starts_with("/mcp ") {
            self.submit_mcp(&text)
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

    fn submit_mcp(&mut self, text: &str) -> AppEffect {
        self.push_user_line(text);
        let mut parts = text["/mcp".len()..].split_whitespace();
        match (parts.next(), parts.next()) {
            (Some("login"), Some(name)) => AppEffect::McpLogin(name.to_string()),
            (Some("logout"), Some(name)) => AppEffect::McpLogout(name.to_string()),
            _ => {
                // Bare `/mcp` (or bad args): reopen the status modal + usage.
                self.show_mcp_modal = !self.mcp_status.is_empty();
                if self.mcp_status.is_empty() {
                    self.transcript
                        .push(dim_line("no MCP servers configured (.mcp.json)"));
                }
                self.transcript
                    .push(dim_line("usage: /mcp login <name> · /mcp logout <name>"));
                AppEffect::None
            }
        }
    }

    pub(super) fn submit_task(&mut self, text: &str) -> AppEffect {
        let rest = text["/task".len()..].trim();
        if rest.is_empty() {
            self.transcript.push(dim_line(
                "usage: /task <pr-number | branch | a task to do on a fresh branch>",
            ));
            return AppEffect::None;
        }
        if !is_linked_worktree(&self.root)
            && std::env::var("AGENTJ_ALLOW_PRIMARY").as_deref() != Ok("1")
        {
            self.transcript.push(dim_line("» /task does a destructive reset to origin and is meant for a dedicated worktree — this looks like the primary checkout. Run agentj in your worktree, or set AGENTJ_ALLOW_PRIMARY=1."));
            return AppEffect::None;
        }
        let (reference, desc) = parse_task_args(rest);
        self.transcript
            .push(dim_line(format!("» re-keying worktree → {reference}")));
        AppEffect::Rekey { reference, desc }
    }
}
