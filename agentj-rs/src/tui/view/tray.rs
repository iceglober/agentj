//! The live activity panel between transcript and status row: the subagent fork/join rail
//! ([`subagent_panel`], one row per delegate hanging off the trunk) and the running background-jobs
//! list ([`jobs_panel`]), plus their row-count math used by the frame layout.

use super::human_tokens;
use crate::tui::app::App;
use crate::tui::theme;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use std::time::{Duration, Instant};

/// Agents shown in the tray at once; more collapse into an "… and N more" line.
const SUBAGENT_TRAY_MAX: usize = 6;
/// Running background jobs shown in the activity panel at once.
const JOBS_PANEL_MAX: usize = 4;

/// Rows the running-jobs list occupies (one per job, capped, plus an overflow line).
pub(super) fn jobs_panel_rows(count: usize) -> u16 {
    if count == 0 {
        return 0;
    }
    (count.min(JOBS_PANEL_MAX) + usize::from(count > JOBS_PANEL_MAX)) as u16
}

/// Live rows for running background jobs: `⚙ [id] <command> · <elapsed> · ⏱<timeout>`.
pub(super) fn jobs_panel(app: &App, now: Instant) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let jobs = &app.jobs;
    let show = jobs.len().min(JOBS_PANEL_MAX);
    for job in jobs.iter().take(show) {
        let cmd: String = job
            .command
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(44)
            .collect();
        let elapsed = fmt_mmss(now.saturating_duration_since(job.started).as_secs());
        let mut spans = vec![
            Span::styled(" ⚙ ", theme::accent()),
            Span::styled(format!("[{}] ", job.id), theme::dim()),
            Span::styled(cmd, theme::muted()),
            Span::styled(format!(" · {elapsed}"), theme::dim()),
        ];
        if let Some(t) = job.timeout {
            spans.push(Span::styled(
                format!(" · ⏱{}", fmt_mmss(t.as_secs())),
                theme::dim(),
            ));
        }
        lines.push(Line::from(spans));
    }
    if jobs.len() > JOBS_PANEL_MAX {
        lines.push(Line::from(Span::styled(
            format!("   … and {} more", jobs.len() - JOBS_PANEL_MAX),
            theme::dim(),
        )));
    }
    lines
}
/// How long a row's status stays "lit" after a progress event before fading to muted.
const ACTIVITY_FLASH: Duration = Duration::from_millis(600);

/// Rail height: one row per agent (capped, plus the overflow line).
pub(super) fn subagent_panel_rows(count: usize) -> u16 {
    if count == 0 {
        return 0;
    }
    let rows = if count > SUBAGENT_TRAY_MAX {
        SUBAGENT_TRAY_MAX // cap-1 agents + the "… and N more" line
    } else {
        count
    };
    rows as u16
}

/// The fork/join rail gutter for agent row `i` of `n`: the first row carries the fork off the
/// trunk, the last closes the fan. A single-agent wave keeps the fork so the `├─╯` join line
/// below it still connects. Every connector is the same width so titles align down the block.
pub fn rail_connector(i: usize, n: usize) -> &'static str {
    if i == 0 {
        "├─┬─"
    } else if i + 1 == n {
        "│ ╰─"
    } else {
        "│ ├─"
    }
}

pub(super) fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else if max == 0 {
        String::new()
    } else {
        let keep = max.saturating_sub(1);
        format!("{}…", s.chars().take(keep).collect::<String>())
    }
}

/// Per-agent elapsed: seconds-precise so it visibly ticks (`47s`, `1m04`, `12m30`).
pub(super) fn fmt_mmss(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m{:02}", secs / 60, secs % 60)
    }
}

/// The live fork/join rail. One row per subagent, hanging off the trunk:
///
/// `├─┬─ ⠸ port the editor tests — bash(cargo test)         ·7 1m04 · 24.1k`
///
/// The connector draws the wave's fork; the SAME connectors reappear when the finished block
/// freezes into the transcript (`App::flush_subagent_summaries`), so the live view and scrollback
/// are one drawing. The full title always wins the width fight — the live status truncates into
/// whatever is left and drops entirely before the title ever would. The right block is the agent's
/// tool-call count, its own elapsed clock, and its live input-token spend. Spinners are
/// phase-shifted per agent so parallel work visibly churns out of sync, a row's status flashes
/// bright for a beat whenever its agent does something, and finished agents stay pinned with a ✓/✗
/// until the whole wave joins.
pub(super) fn subagent_panel(app: &App, now: Instant, width: u16) -> Vec<Line<'static>> {
    let total = app.subagents.len();
    let mut lines = Vec::new();
    if total == 0 {
        return lines;
    }

    let overflow = total > SUBAGENT_TRAY_MAX;
    let show = if overflow {
        SUBAGENT_TRAY_MAX - 1
    } else {
        total
    };
    // With an overflow line the fan must not close on the last visible row — the "… and N more"
    // line is the one that ends the block.
    let fan = if overflow { show + 1 } else { total };
    for (pos, (id, row)) in app.subagents.iter().take(show).enumerate() {
        // Right block: `·{steps} {elapsed} · {tok}` — frozen once the agent finishes.
        let elapsed = match row.final_ms {
            Some(ms) => fmt_mmss(ms / 1000),
            None => fmt_mmss(now.saturating_duration_since(row.started).as_secs()),
        };
        let mut meta = format!("·{} {elapsed}", row.steps);
        if row.tokens_in > 0 {
            meta.push_str(&format!(" · {}", human_tokens(row.tokens_in)));
        }

        let connector = Span::styled(rail_connector(pos, fan), theme::dim());

        // Glyph after the connector: staggered spinner while running (bold during the activity
        // flash), ✓/✗ done.
        let flashing =
            row.done.is_none() && now.saturating_duration_since(row.last_activity) < ACTIVITY_FLASH;
        let glyph = match row.done {
            Some(true) => Span::styled(" ✓ ", theme::ok()),
            Some(false) => Span::styled(" ✗ ", theme::err()),
            None => {
                let frame = theme::SPINNER[(app.spinner + id * 3) % theme::SPINNER.len()];
                let style = if flashing {
                    theme::accent_bold()
                } else {
                    theme::accent()
                };
                Span::styled(format!(" {frame} "), style)
            }
        };

        // Width budget: connector (4) + glyph (3) + title first, then ` — status`, then the
        // right-aligned meta.
        let budget = (width as usize).saturating_sub(7 + meta.chars().count() + 1);
        let title = clip(&row.desc, budget);
        let title_style = if row.done.is_some() {
            theme::muted()
        } else {
            Style::default()
        };
        let mut spans = vec![connector, glyph, Span::styled(title.clone(), title_style)];

        let mut used = title.chars().count();
        let status_room = budget.saturating_sub(used + 3); // " — "
        if status_room >= 4 && !row.status.trim().is_empty() {
            let status = clip(&row.status, status_room);
            used += 3 + status.chars().count();
            let status_style = if row.done.is_some() {
                theme::dim()
            } else if flashing {
                Style::default() // lit while the agent is actively doing something
            } else {
                theme::muted()
            };
            spans.push(Span::styled(" — ", theme::dim()));
            spans.push(Span::styled(status, status_style));
        }

        let pad = (width as usize).saturating_sub(7 + used + meta.chars().count());
        spans.push(Span::raw(" ".repeat(pad)));
        spans.push(Span::styled(meta, theme::dim()));
        lines.push(Line::from(spans));
    }
    if overflow {
        lines.push(Line::from(Span::styled(
            format!("│ ╰─ … and {} more", total - show),
            theme::dim(),
        )));
    }
    lines
}
