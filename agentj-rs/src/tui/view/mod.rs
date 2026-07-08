//! Rendering: turns `App` state into the ratatui layout (transcript / subagent panel / status /
//! input / footer, plus the floating slash-command popover), with the transcript/input line builders
//! and their cached row-count bookkeeping.
//!
//! This file is the frame composer: [`draw`] lays out the regions and paints each one, plus the
//! small shared formatters ([`dim_line`], [`fmt_ms`], [`human_tokens`]) and the finished-frame
//! selection overlay. Each concept lives in its own submodule:
//!  - `transcript` — the scrollback [`TranscriptView`], its line builders ([`assistant_block`],
//!    [`tool_end_line`]) and display sanitizing
//!  - `input` — the exactly-wrapped input box ([`InputLayout`], [`layout_input`]) and its
//!    per-revision [`InputLayoutCache`]
//!  - `status` — the status row (left status + right-aligned session segment) and the
//!    slash-command popover
//!  - `tray` — the live subagent fork/join rail and the running-jobs panel
//!  - `modal` — the centered modals: Ctrl-P menu, MCP server status, provider-setup wizard
//!  - `perf` — test-only `PerfMetrics` counters for batching / layout-cache assertions

mod input;
mod modal;
#[cfg(test)]
mod perf;
mod status;
mod transcript;
mod tray;

#[cfg(test)]
mod tests;

pub use input::InputLayoutCache;
#[cfg(test)]
pub use perf::{note_batch, PerfMetrics};
pub use transcript::{assistant_block, tool_end_line, LineKind, TranscriptView};
pub use tray::rail_connector;

use modal::{render_mcp_modal, render_menu_modal, render_setup_modal};
use status::{popover_lines, status_line};
use transcript::{visible_transcript_rows, GUTTER, LABEL_W};
use tray::{jobs_panel, jobs_panel_rows, subagent_panel, subagent_panel_rows};

use super::app::{App, Selection, TranscriptGeom};
use super::theme;
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Padding, Paragraph};
use ratatui::Frame;
use std::time::{Duration, Instant};
use tachyonfx::EffectRenderer;

pub fn dim_line(s: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(s.into(), theme::dim()))
}

pub fn fmt_ms(ms: u128) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}

pub fn human_tokens(n: u64) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

/// Render one frame from the current `App` state.
pub fn draw(f: &mut Frame, app: &mut App) {
    // Frame delta for effects, capped so a long gap between frames doesn't skip an animation.
    let now = Instant::now();
    let frame_dt = app
        .last_draw
        .map(|t| now.duration_since(t).min(Duration::from_millis(250)))
        .unwrap_or_default();
    app.last_draw = Some(now);

    let area = f.area();
    let in_h = app.input_cache.rows;
    let panel_h = subagent_panel_rows(app.subagents.len()) + jobs_panel_rows(app.jobs.len());
    let rows = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(panel_h),
        Constraint::Length(1),
        Constraint::Length(in_h),
        Constraint::Length(1),
    ])
    .split(area);
    let (r_main, r_tray, r_status, r_input, r_footer) =
        (rows[0], rows[1], rows[2], rows[3], rows[4]);

    // Main pane (with a bottom divider). A little side padding, a moderate bottom gap above the
    // divider; the top stays flush. Holds the transcript.
    const PAD_X: u16 = 1;
    const PAD_BOTTOM: u16 = 2;
    let viewport = r_main.height.saturating_sub(1 + PAD_BOTTOM); // border + bottom padding
    let content_width = r_main.width.saturating_sub(2 * PAD_X);
    // The transcript reserves a left type-label column + the card gutter; text wraps in what's left.
    let text_width = content_width.saturating_sub((GUTTER + LABEL_W) as u16);
    let main_block = || {
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(theme::divider_color()))
            .padding(Padding::new(PAD_X, PAD_X, 0, PAD_BOTTOM))
    };
    // Auto-follow the tail unless the user scrolled up.
    app.transcript.ensure_width(text_width);
    let max = app.transcript.max_scroll(viewport);
    if app.follow {
        app.scroll = max;
    }
    app.scroll = app.scroll.min(max);
    // Paging back down to the bottom resumes following (and keeps the scrolled-up badge honest:
    // "scroll down for latest" is literally the way back).
    if app.scroll >= max {
        app.follow = true;
    }
    // Record the transcript's top row + height so a drag past its edge can auto-scroll while selecting.
    app.tgeom = Some(TranscriptGeom {
        y: r_main.y,
        viewport,
    });
    // Wrap only the on-screen window ourselves (not ratatui's Wrap widget) so the wrap, the scroll
    // math, and the selection map agree; tint any selected cells while we're at it.
    let (_first, window, kinds, intra, block_start) = app.transcript.window(app.scroll, viewport);
    let visible = visible_transcript_rows(window, kinds, block_start, text_width, viewport, intra);
    // Clear the whole region first: a default Block doesn't paint its padding cells, so without this
    // the side/bottom padding retains stale glyphs pinned to screen coordinates as content scrolls.
    f.render_widget(Clear, r_main);
    f.render_widget(Paragraph::new(visible).block(main_block()), r_main);

    // Scrolled-up badge: the tail keeps growing below while the user reads history — say so, and
    // say how to get back. (Paging to the bottom restores follow; see the clamp above.)
    if !app.follow && r_main.height > 2 {
        let hint = " ↓ scroll down for latest ";
        let w = hint.chars().count() as u16;
        if r_main.width > w + 2 {
            let rect = ratatui::layout::Rect {
                x: r_main.x + r_main.width - w - 1,
                y: r_main.y + r_main.height.saturating_sub(2), // the blank padding row above the divider
                width: w,
                height: 1,
            };
            f.render_widget(Clear, rect);
            f.render_widget(Paragraph::new(Span::styled(hint, theme::accent())), rect);
        }
    }

    // Live subagent panel (only present while a delegate batch runs). A fresh batch coalesces into
    // place; the effect rides the running-turn ticker, so idle frames never animate.
    if panel_h > 0 {
        // Clear the tray region before drawing its text/effect. The coalesce effect overdraws this
        // rect and the tray's height can change frame-to-frame; without an explicit clear, stale
        // cells can remain pinned to screen coordinates after the tray collapses or reflows.
        f.render_widget(Clear, r_tray);
        let mut panel = subagent_panel(app, Instant::now(), r_tray.width);
        panel.extend(jobs_panel(app, Instant::now()));
        f.render_widget(Paragraph::new(panel), r_tray);
        if let Some(fx_) = app.tray_fx.as_mut() {
            f.render_effect(fx_, r_tray, frame_dt.into());
            if fx_.done() {
                app.tray_fx = None;
            }
        }
    } else {
        app.tray_fx = None;
    }

    // Status line (left status + right-aligned session segment).
    f.render_widget(
        Paragraph::new(status_line(app, Instant::now(), r_status.width)),
        r_status,
    );

    // Input rows are pre-wrapped char-exact (no Wrap widget), so the cursor math is authoritative
    // and whitespace-only lines render; taller-than-cap input scrolls to keep the cursor visible.
    // During setup the modal owns the input (and the cursor), so the box just shows a hint.
    if app.setup.is_some() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled("  ⏎ next · Esc cancel", theme::dim()))),
            r_input,
        );
    } else {
        f.render_widget(
            Paragraph::new(app.input_cache.rendered.clone()).scroll((app.input_cache.scroll, 0)),
            r_input,
        );
        let (crow, ccol) = app.input_cache.cursor;
        f.set_cursor_position(Position::new(
            (r_input.x + 2 + ccol).min(r_input.x + r_input.width.saturating_sub(1)),
            (r_input.y + crow).min(r_input.y + r_input.height.saturating_sub(1)),
        ));
    }

    // Footer: identity line, tucked by the prompt.
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            format!("agentj · {}/{} · {}", app.provider, app.model_id, app.root),
            theme::dim(),
        ))),
        r_footer,
    );

    // Slash-command popover, floated above the status row.
    let popover = popover_lines(app);
    if !popover.is_empty() {
        let h = popover.len() as u16;
        let w = popover
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.chars().count()).sum::<usize>())
            .max()
            .unwrap_or(0)
            .min(area.width as usize) as u16;
        let y = r_status.y.saturating_sub(h);
        let rect = ratatui::layout::Rect {
            x: r_input.x,
            y,
            width: w.max(1),
            height: h.min(area.height),
        };
        f.render_widget(Clear, rect);
        f.render_widget(Paragraph::new(popover), rect);
    }

    // Modals, one at a time: setup > command menu > MCP status.
    if app.setup.is_some() {
        render_setup_modal(f, app, area);
    } else if app.menu.is_some() {
        render_menu_modal(f, app, area);
    } else if app.mcp_modal_open() {
        render_mcp_modal(f, app, area);
    }

    // Selection is applied to the finished frame (after every widget, including modals), so it can
    // highlight anything on screen; the frame's text is snapshotted so copy reads exactly what shows.
    if let Some(sel) = app.selection {
        apply_screen_selection(f.buffer_mut(), sel);
        app.screen_rows = snapshot_screen(f.buffer_mut());
    }
}

/// Reverse-video the selected screen cells in the finished frame buffer.
fn apply_screen_selection(buf: &mut ratatui::buffer::Buffer, sel: Selection) {
    let ((sx, sy), (ex, ey)) = sel.ordered();
    let hl = theme::selection_style();
    let area = buf.area;
    for y in sy..=ey {
        if y < area.top() || y >= area.bottom() {
            continue;
        }
        let x0 = if y == sy { sx } else { area.left() };
        let x1 = if y == ey { ex } else { area.right() };
        for x in x0..x1.min(area.right()) {
            if x < area.left() {
                continue;
            }
            if let Some(cell) = buf.cell_mut(Position::new(x, y)) {
                cell.set_style(cell.style().patch(hl));
            }
        }
    }
}

/// The finished frame's text, one String per screen row (for copy).
fn snapshot_screen(buf: &ratatui::buffer::Buffer) -> Vec<String> {
    let area = buf.area;
    (area.top()..area.bottom())
        .map(|y| {
            (area.left()..area.right())
                .map(|x| buf.cell(Position::new(x, y)).map(|c| c.symbol()).unwrap_or(" "))
                .collect::<String>()
        })
        .collect()
}
