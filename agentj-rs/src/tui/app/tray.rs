//! The live subagent tray shown while a delegate batch runs, and the frozen fork/join summaries it
//! collapses into when the wave joins.

use super::App;
use crate::tui::theme;
use crate::tui::view::{fmt_ms, human_tokens, rail_connector};
use ratatui::text::{Line, Span};
use std::time::Instant;

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
    /// Live input-token spend, accumulated from this agent's SubagentUsage events.
    pub tokens_in: u64,
}

/// Drop a trailing " · N tok" (the delegate summary's spend suffix, aimed at the headless/eval
/// stream) so the TUI, which meters tokens itself, doesn't show the figure twice.
pub(super) fn strip_tok_suffix(s: &str) -> &str {
    let Some(rest) = s.strip_suffix(" tok") else {
        return s;
    };
    let Some(pos) = rest.rfind(" · ") else {
        return s;
    };
    let digits = &rest[pos + " · ".len()..];
    if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
        &s[..pos]
    } else {
        s
    }
}

impl App {
    /// Collapse the agent tray: every finished subagent gets a permanent ✓/✗ summary line in the
    /// transcript (still-running rows just vanish — their turn was aborted). Called when a delegate
    /// batch completes, and on turn end/abort as a safety net.
    /// Freeze the finished wave into the transcript as the same fork/join rail the live panel
    /// drew, closed by a join line with the wave's aggregates — scrollback keeps the fork/join shape.
    pub(super) fn flush_subagent_summaries(&mut self) {
        self.tray_fx = None;
        let rows = std::mem::take(&mut self.subagents);
        let finished: Vec<&SubagentRow> = rows.values().filter(|r| r.done.is_some()).collect();
        let n = finished.len();
        if n == 0 {
            return;
        }
        for (pos, row) in finished.iter().enumerate() {
            let ok = row.done == Some(true);
            let (glyph, style) = if ok {
                ("✓", theme::ok())
            } else {
                ("✗", theme::err())
            };
            let mut spans = vec![
                Span::styled(format!("{} ", rail_connector(pos, n)), theme::dim()),
                Span::styled(format!("{glyph} "), style),
                Span::styled(row.desc.clone(), theme::muted()),
            ];
            if !row.status.trim().is_empty() {
                spans.push(Span::styled(format!(" · {}", row.status), theme::dim()));
            }
            let mut meta = row
                .final_ms
                .map(|ms| format!(" — {}", fmt_ms(ms as u128)))
                .unwrap_or_default();
            if row.tokens_in > 0 {
                meta.push_str(&format!(" · {} tok", human_tokens(row.tokens_in)));
            }
            if !meta.is_empty() {
                spans.push(Span::styled(meta, theme::dim()));
            }
            self.transcript.push(Line::from(spans));
        }
        self.waves += 1;
        let ok_count = finished.iter().filter(|r| r.done == Some(true)).count();
        // Wave wall-clock is the slowest agent; spend is the sum of every agent's input tokens.
        let wall_ms = finished
            .iter()
            .filter_map(|r| r.final_ms)
            .max()
            .unwrap_or(0);
        let toks: u64 = finished.iter().map(|r| r.tokens_in).sum();
        let mut join = format!(
            "├─╯  wave {} · {ok_count}/{n} ok · {}",
            self.waves,
            fmt_ms(wall_ms as u128)
        );
        if toks > 0 {
            join.push_str(&format!(" · {} tok", human_tokens(toks)));
        }
        self.transcript
            .push(Line::from(Span::styled(join, theme::dim())));
        self.dirty = true;
    }
}
