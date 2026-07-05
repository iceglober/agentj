//! The one-row status line (spinner + label while running, else the effect toast or `· ready`,
//! with a right-aligned `ctx · elapsed` session segment) and the slash-command popover that floats
//! above it.

use super::human_tokens;
use crate::tui::app::App;
use crate::tui::theme;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::time::Instant;

fn fmt_session(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// The context-fill segment (`ctx 34% (12.4k/200k)`), or `None` when the window is unknown.
fn ctx_segment(app: &App) -> Option<(String, bool)> {
    let (u, window) = (app.last_usage?, app.context_window?);
    if window == 0 {
        return None;
    }
    let pct = ((u.prompt_tokens as f64 / window as f64) * 100.0).round() as u64;
    let text = format!(
        "ctx {pct}% ({}/{})",
        human_tokens(u.prompt_tokens),
        human_tokens(window)
    );
    Some((text, pct >= 80))
}

/// Assemble the right-status text, dropping lowest-priority parts until it fits `avail` columns.
/// Display order: ctx · elapsed. Drop order (first dropped): elapsed, then ctx.
pub(super) fn right_status_text(ctx: Option<&str>, elapsed: &str, avail: usize) -> String {
    for (with_elapsed, with_ctx) in [(true, true), (false, true), (false, false)] {
        let mut parts: Vec<&str> = Vec::new();
        if with_ctx {
            if let Some(ctx) = ctx {
                parts.push(ctx);
            }
        }
        if with_elapsed {
            parts.push(elapsed);
        }
        let s = parts.join(" · ");
        if s.chars().count() <= avail {
            return s;
        }
    }
    String::new()
}

/// Left side of the status row: spinner + label while running, else the effect toast or `· ready`.
fn status_left(app: &App) -> Vec<Span<'static>> {
    let accent = theme::pulse_color(app.running);
    let effect_active = app.effect_active();
    if app.running {
        let elapsed = app.since.elapsed().as_secs();
        let base = theme::SPINNER[app.spinner % theme::SPINNER.len()];
        let label = if app.status.is_empty() {
            "thinking".to_string()
        } else {
            app.status.clone()
        };
        let mut spans = vec![
            Span::styled(
                format!("{base} "),
                Style::default().fg(accent).add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!("{label} · {elapsed}s")),
        ];
        if effect_active && !app.effect_label.is_empty() {
            spans.push(Span::styled(
                format!("  {} {}", theme::sparkle(), app.effect_label),
                theme::muted(),
            ));
        }
        spans
    } else if effect_active && !app.effect_label.is_empty() {
        vec![
            Span::styled(format!("{} ", theme::sparkle()), theme::muted()),
            Span::styled(app.effect_label.clone(), theme::muted()),
        ]
    } else {
        vec![Span::styled(
            format!("{} ready", theme::sparkle()),
            Style::default().fg(accent),
        )]
    }
}

fn span_width(spans: &[Span<'_>]) -> usize {
    spans.iter().map(|s| s.content.chars().count()).sum()
}

/// The full status row: left status + a right-aligned session segment (ctx · elapsed).
pub(super) fn status_line(app: &App, now: Instant, width: u16) -> Line<'static> {
    let mut spans = status_left(app);
    let left_w = span_width(&spans);
    let elapsed = fmt_session(now.saturating_duration_since(app.session_start).as_secs());
    let ctx = ctx_segment(app);
    let ctx_text = ctx.as_ref().map(|(t, _)| t.as_str());
    let avail = (width as usize).saturating_sub(left_w + 1);
    let right = right_status_text(ctx_text, &elapsed, avail);
    if !right.is_empty() {
        let right_w = right.chars().count();
        let pad = (width as usize).saturating_sub(left_w + right_w);
        let warn = ctx.map(|(_, w)| w).unwrap_or(false) && right.contains("ctx");
        let style = if warn {
            Style::default().fg(theme::WARN)
        } else {
            theme::muted()
        };
        spans.push(Span::raw(" ".repeat(pad)));
        spans.push(Span::styled(right, style));
    }
    Line::from(spans)
}

/// The slash-command popover, anchored above the status row.
pub(super) fn popover_lines(app: &App) -> Vec<Line<'static>> {
    const MAX_ITEMS: usize = 6;
    let Some(p) = &app.popover else {
        return Vec::new();
    };
    p.items
        .iter()
        .take(MAX_ITEMS)
        .enumerate()
        .map(|(i, cmd)| {
            let selected = i == p.selected;
            let (marker, name_style, summary_style) = if selected {
                (
                    Span::styled("▸ ", theme::accent()),
                    theme::accent_bold().add_modifier(Modifier::REVERSED),
                    theme::muted().add_modifier(Modifier::REVERSED),
                )
            } else {
                (Span::raw("  "), theme::accent(), theme::dim())
            };
            Line::from(vec![
                marker,
                Span::styled(format!("{:<8}", cmd.name), name_style),
                Span::styled(format!(" {}", cmd.summary), summary_style),
            ])
        })
        .collect()
}
