//! Rendering: turns `App` state into the ratatui layout (transcript / subagent panel / status /
//! input / footer, plus the floating slash-command popover), with the transcript/input line builders
//! and their cached row-count bookkeeping.

use super::app::App;
use super::editor::Editor;
use super::markdown::render_markdown;
use super::theme;
use crate::commands::{classify, TokenClass, SLASH_COMMANDS};
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;
use std::time::Instant;

pub const MAX_INPUT_ROWS: u16 = 8;

pub fn dim_line(s: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(s.into(), theme::dim()))
}

/// An assistant message rendered as markdown, with a single dim bullet on the first line and a
/// two-space indent on the rest so one message reads as one block.
pub fn assistant_block(text: &str) -> Vec<Line<'static>> {
    let mut lines = render_markdown(text);
    if lines.is_empty() {
        lines.push(Line::default());
    }
    for (i, line) in lines.iter_mut().enumerate() {
        let prefix = if i == 0 {
            Span::styled("● ", theme::dim())
        } else {
            Span::raw("  ")
        };
        line.spans.insert(0, prefix);
    }
    lines
}

/// A finished tool call: dim `·` when it succeeded, red `✗` when it failed.
pub fn tool_end_line(tool: &str, ok: bool, elapsed_ms: u128, summary: &str) -> Line<'static> {
    let (glyph, glyph_style) = if ok {
        ("·", theme::dim())
    } else {
        ("✗", theme::err())
    };
    let mut spans = vec![
        Span::styled(format!("{glyph} "), glyph_style),
        Span::styled(tool.to_string(), theme::muted()),
        Span::styled(format!(" — {}", fmt_ms(elapsed_ms)), theme::dim()),
    ];
    if !summary.trim().is_empty() {
        spans.push(Span::styled(format!(" {summary}"), theme::dim()));
    }
    Line::from(spans)
}

/// Styled content spans for one logical input line (no gutter). The first line gets its command
/// token colored by `classify`.
fn input_line_spans(line: &str, is_first: bool) -> Vec<Span<'static>> {
    if !is_first {
        if line.is_empty() {
            return vec![];
        }
        return vec![Span::raw(line.to_string())];
    }
    let (token, rest, class) = classify(line, SLASH_COMMANDS);
    let mut spans = Vec::new();
    if !token.is_empty() {
        spans.push(match class {
            TokenClass::Plain => Span::raw(token),
            TokenClass::Exact => Span::styled(token, theme::accent_bold()),
            TokenClass::Prefix => Span::styled(token, theme::accent()),
            TokenClass::Unknown => Span::styled(token, theme::err()),
        });
    }
    if !rest.is_empty() {
        spans.push(Span::raw(rest));
    }
    spans
}

/// Split styled spans into visual rows of at most `cw` characters, preserving styles across the
/// split. Always yields at least one (possibly empty) row.
fn chunk_spans(spans: Vec<Span<'static>>, cw: usize) -> Vec<Vec<Span<'static>>> {
    let cw = cw.max(1);
    let mut rows: Vec<Vec<Span<'static>>> = Vec::new();
    let mut cur: Vec<Span<'static>> = Vec::new();
    let mut used = 0usize;
    for span in spans {
        let style = span.style;
        let mut content = span.content.into_owned();
        loop {
            let n = content.chars().count();
            let avail = cw - used;
            if n <= avail {
                if n > 0 {
                    used += n;
                    cur.push(Span::styled(content, style));
                }
                break;
            }
            let split_at = content
                .char_indices()
                .nth(avail)
                .map(|(i, _)| i)
                .unwrap_or(content.len());
            if avail > 0 {
                cur.push(Span::styled(content[..split_at].to_string(), style));
            }
            content = content[split_at..].to_string();
            rows.push(std::mem::take(&mut cur));
            used = 0;
        }
    }
    rows.push(cur);
    rows
}

/// The input box, laid out exactly: every visual row is pre-wrapped at the content width (char
/// wrapping, matching the cursor math — ratatui's word-wrapper is NOT used, so whitespace-only lines
/// render and the cursor can never drift from the text).
pub struct InputLayout {
    /// Pre-wrapped visual rows, each prefixed with a 2-char gutter (`› ` on the first, spaces after).
    pub lines: Vec<Line<'static>>,
    pub total_rows: u16,
    /// Cursor position: (visual row index, content column — add the 2-char gutter for screen x).
    pub cursor: (u16, u16),
}

pub fn layout_input(text: &str, cursor: usize, width: u16) -> InputLayout {
    let cw = width.saturating_sub(2).max(1) as usize;

    // Locate the cursor: which logical line, and how many chars into it.
    let cursor_line = text[..cursor].matches('\n').count();
    let line_start = text[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let cursor_chars = text[line_start..cursor].chars().count();

    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut cursor_pos = (0u16, 0u16);
    for (i, logical) in text.split('\n').enumerate() {
        let rows = chunk_spans(input_line_spans(logical, i == 0), cw);
        if i == cursor_line {
            // Keep the cursor on its own line's last row when it sits exactly at a wrap boundary.
            let (mut row, mut col) = (cursor_chars / cw, cursor_chars % cw);
            if cursor_chars > 0 && col == 0 {
                row -= 1;
                col = cw;
            }
            cursor_pos = ((lines.len() + row) as u16, col as u16);
        }
        for (r, mut row_spans) in rows.into_iter().enumerate() {
            let gutter = if lines.is_empty() && r == 0 {
                Span::styled("› ", theme::dim())
            } else {
                Span::raw("  ")
            };
            row_spans.insert(0, gutter);
            lines.push(Line::from(row_spans));
        }
    }
    let total_rows = lines.len() as u16;
    InputLayout {
        lines,
        total_rows,
        cursor: cursor_pos,
    }
}

pub fn fmt_ms(ms: u128) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}


fn line_width(line: &Line<'_>) -> usize {
    line.spans
        .iter()
        .map(|span| span.content.chars().count())
        .sum::<usize>()
}

fn wrapped_rows_for_line(line: &Line<'_>, width: u16) -> usize {
    let content_width = width.saturating_sub(2).max(1) as usize;
    line_width(line).max(1).div_ceil(content_width)
}

fn transcript_rows(lines: &[Line<'_>], width: u16) -> usize {
    lines
        .iter()
        .map(|line| wrapped_rows_for_line(line, width))
        .sum()
}

/// The scrollback buffer: pre-rendered lines plus a cached wrapped-row count so appending and
/// scrolling don't re-measure the whole transcript each frame.
pub struct TranscriptView {
    lines: Vec<Line<'static>>,
    text: Text<'static>,
    total_rows: usize,
    cached_width: u16,
}

impl TranscriptView {
    pub fn new(lines: Vec<Line<'static>>) -> Self {
        let text = Text::from(lines.clone());
        Self {
            lines,
            text,
            total_rows: 0,
            cached_width: 0,
        }
    }

    pub fn text(&self) -> Text<'static> {
        self.text.clone()
    }

    pub fn ensure_width(&mut self, width: u16) {
        if self.cached_width != width {
            self.cached_width = width;
            self.total_rows = transcript_rows(&self.lines, width);
        }
    }

    pub fn max_scroll(&self, viewport: u16) -> u16 {
        self.total_rows.saturating_sub(viewport as usize) as u16
    }

    pub fn push(&mut self, line: Line<'static>) {
        if self.cached_width != 0 {
            self.total_rows += wrapped_rows_for_line(&line, self.cached_width);
        }
        self.text.lines.push(line.clone());
        self.lines.push(line);
    }

    pub fn extend<I>(&mut self, iter: I)
    where
        I: IntoIterator<Item = Line<'static>>,
    {
        for line in iter {
            self.push(line);
        }
    }
}

pub struct InputLayoutCache {
    revision: u64,
    width: u16,
    /// Visible rows (total capped at `MAX_INPUT_ROWS`; taller input scrolls).
    pub rows: u16,
    pub rendered: Text<'static>,
    /// Cursor within the visible area: (row - scroll, content column).
    pub cursor: (u16, u16),
    /// First visual row shown (input taller than the cap scrolls to keep the cursor visible).
    pub scroll: u16,
}

impl Default for InputLayoutCache {
    fn default() -> Self {
        Self {
            revision: u64::MAX,
            width: 0,
            rows: 1,
            rendered: Text::from(""),
            cursor: (0, 0),
            scroll: 0,
        }
    }
}

impl InputLayoutCache {
    pub fn refresh(&mut self, editor: &Editor, width: u16) {
        self.refresh_with_metrics(editor, width, None);
    }

    pub fn refresh_with_metrics(
        &mut self,
        editor: &Editor,
        width: u16,
        #[cfg(test)] metrics: Option<&mut PerfMetrics>,
        #[cfg(not(test))] _metrics: Option<&mut ()>,
    ) {
        if self.revision == editor.revision() && self.width == width {
            #[cfg(test)]
            if let Some(metrics) = metrics {
                metrics.input_layout_cache_hits += 1;
            }
            return;
        }
        #[cfg(test)]
        if let Some(metrics) = metrics {
            metrics.input_layout_refreshes += 1;
        }
        self.revision = editor.revision();
        self.width = width;
        let layout = layout_input(editor.text(), editor.cursor, width);
        let shown = layout.total_rows.clamp(1, MAX_INPUT_ROWS);
        let max_scroll = layout.total_rows.saturating_sub(shown);
        // Keep the previous scroll where possible, but always keep the cursor in view.
        let scroll = self
            .scroll
            .min(max_scroll)
            .clamp(layout.cursor.0.saturating_sub(shown - 1), layout.cursor.0);
        self.rows = shown;
        self.scroll = scroll;
        self.cursor = (layout.cursor.0 - scroll, layout.cursor.1);
        self.rendered = Text::from(layout.lines);
    }
}

/// Rows the live subagent panel occupies (0 when no subagents are running, capped).
const SUBAGENT_PANEL_MAX: usize = 6;

fn subagent_panel_rows(count: usize) -> u16 {
    count.min(SUBAGENT_PANEL_MAX) as u16
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else if max == 0 {
        String::new()
    } else {
        let keep = max.saturating_sub(1);
        format!("{}…", s.chars().take(keep).collect::<String>())
    }
}

/// One row per running subagent: `⠋ [id] desc · status · 12s`. Overflow past the cap collapses to a
/// final "… and N more" line.
fn subagent_panel(app: &App, now: Instant, width: u16) -> Vec<Line<'static>> {
    let total = app.subagents.len();
    let overflow = total > SUBAGENT_PANEL_MAX;
    let show = if overflow {
        SUBAGENT_PANEL_MAX - 1
    } else {
        total
    };
    let spin = theme::SPINNER[app.spinner % theme::SPINNER.len()];
    let mut lines = Vec::new();
    for (id, row) in app.subagents.iter().take(show) {
        let elapsed = now.saturating_duration_since(row.started).as_secs();
        let head = format!(" {spin} [{id}] ");
        let tail = format!(" · {elapsed}s");
        let budget = (width as usize).saturating_sub(head.chars().count() + tail.chars().count());
        let desc = clip(&row.desc, budget / 2);
        let status_room = budget.saturating_sub(desc.chars().count() + 3); // " · "
        let status = clip(&row.status, status_room);
        lines.push(Line::from(vec![
            Span::styled(format!(" {spin} "), theme::accent()),
            Span::styled(format!("[{id}] "), theme::muted()),
            Span::raw(desc),
            Span::styled(format!(" · {status}"), theme::muted()),
            Span::styled(tail, theme::dim()),
        ]));
    }
    if overflow {
        lines.push(Line::from(Span::styled(
            format!("   … and {} more", total - show),
            theme::dim(),
        )));
    }
    lines
}

fn human_tokens(n: u64) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

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
fn right_status_text(ctx: Option<&str>, elapsed: &str, avail: usize) -> String {
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
fn status_line(app: &App, now: Instant, width: u16) -> Line<'static> {
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
fn popover_lines(app: &App) -> Vec<Line<'static>> {
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

/// Render one frame from the current `App` state.
pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    let in_h = app.input_cache.rows;
    let panel_h = subagent_panel_rows(app.subagents.len());
    let rows = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(panel_h),
        Constraint::Length(1),
        Constraint::Length(in_h),
        Constraint::Length(1),
    ])
    .split(area);

    // Transcript (with a bottom divider). Auto-follow the tail unless the user scrolled up.
    let viewport = rows[0].height.saturating_sub(1); // minus the border row
    app.transcript.ensure_width(rows[0].width);
    let max = app.transcript.max_scroll(viewport);
    if app.follow {
        app.scroll = max;
    }
    app.scroll = app.scroll.min(max);
    f.render_widget(
        Paragraph::new(app.transcript.text())
            .block(
                Block::default()
                    .borders(Borders::BOTTOM)
                    .border_style(Style::default().fg(theme::divider_color())),
            )
            .wrap(Wrap { trim: false })
            .scroll((app.scroll, 0)),
        rows[0],
    );

    // Live subagent panel (only present while a delegate batch runs).
    if panel_h > 0 {
        f.render_widget(
            Paragraph::new(subagent_panel(app, Instant::now(), rows[1].width)),
            rows[1],
        );
    }

    // Status line (left status + right-aligned session segment).
    f.render_widget(
        Paragraph::new(status_line(app, Instant::now(), rows[2].width)),
        rows[2],
    );

    // Input rows are pre-wrapped char-exact (no Wrap widget), so the cursor math is authoritative
    // and whitespace-only lines render; taller-than-cap input scrolls to keep the cursor visible.
    f.render_widget(
        Paragraph::new(app.input_cache.rendered.clone()).scroll((app.input_cache.scroll, 0)),
        rows[3],
    );
    let (crow, ccol) = app.input_cache.cursor;
    f.set_cursor_position(Position::new(
        (rows[3].x + 2 + ccol).min(rows[3].x + rows[3].width.saturating_sub(1)),
        (rows[3].y + crow).min(rows[3].y + rows[3].height.saturating_sub(1)),
    ));

    // Footer: identity line, tucked by the prompt.
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            format!("agentj · {} · {}", app.model_id, app.root),
            theme::dim(),
        ))),
        rows[4],
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
        let y = rows[2].y.saturating_sub(h);
        let rect = ratatui::layout::Rect {
            x: rows[3].x,
            y,
            width: w.max(1),
            height: h.min(area.height),
        };
        f.render_widget(Clear, rect);
        f.render_widget(Paragraph::new(popover), rect);
    }
}

#[cfg(test)]
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerfMetrics {
    pub input_batches: u64,
    pub input_events_total: u64,
    pub input_batch_max: usize,
    pub ui_batches: u64,
    pub ui_events_total: u64,
    pub ui_batch_max: usize,
    pub input_layout_refreshes: u64,
    pub input_layout_cache_hits: u64,
}

#[cfg(test)]
pub fn note_batch(metrics: &mut PerfMetrics, len: usize, input: bool) {
    if input {
        metrics.input_batches += 1;
        metrics.input_events_total += len as u64;
        metrics.input_batch_max = metrics.input_batch_max.max(len);
    } else {
        metrics.ui_batches += 1;
        metrics.ui_events_total += len as u64;
        metrics.ui_batch_max = metrics.ui_batch_max.max(len);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed(s: &str) -> Editor {
        let mut e = Editor::default();
        e.insert_str(s);
        e
    }

    fn row_text(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn wrapped_input_rows_and_cursor_are_tracked() {
        // width 5 → content width 3: "abcdef" wraps into 2 rows; cursor at the end sits on row 1.
        let l = layout_input("abcdef", 6, 5);
        assert_eq!(l.total_rows, 2);
        assert_eq!(l.cursor, (1, 3));
        assert_eq!(row_text(&l.lines[0]), "› abc");
        assert_eq!(row_text(&l.lines[1]), "  def");

        // cursor after "cde" = exactly at the wrap boundary → stays on its row at col 3
        let l = layout_input("ab\ncdef", 6, 5);
        assert_eq!(l.total_rows, 3); // "ab", "cde", "f"
        assert_eq!(l.cursor, (1, 3));
    }

    #[test]
    fn blank_lines_render_and_typing_after_them_lands_on_the_right_row() {
        // Regression: newlines with no non-whitespace used to collapse under the word-wrapper,
        // leaving typed text invisible / the cursor drifting.
        let l = layout_input("\n\n\nword", 3 + "word".len(), 40);
        assert_eq!(l.total_rows, 4);
        assert_eq!(row_text(&l.lines[0]), "› ");
        assert_eq!(row_text(&l.lines[1]), "  ");
        assert_eq!(row_text(&l.lines[2]), "  ");
        assert_eq!(row_text(&l.lines[3]), "  word");
        assert_eq!(l.cursor, (3, 4));
    }

    #[test]
    fn tall_input_scrolls_to_keep_the_cursor_visible() {
        let mut cache = InputLayoutCache::default();
        let mut editor = ed(&"line\n".repeat(11)); // 12 logical lines, cursor at end
        cache.refresh(&editor, 40);
        assert_eq!(cache.rows, MAX_INPUT_ROWS);
        assert_eq!(cache.scroll, 12 - MAX_INPUT_ROWS);
        assert_eq!(cache.cursor.0, MAX_INPUT_ROWS - 1); // cursor pinned to the last visible row

        // Moving the cursor back to the top scrolls back up.
        for _ in 0..12 {
            editor.up();
        }
        cache.refresh(&editor, 40);
        assert_eq!(cache.scroll, 0);
        assert_eq!(cache.cursor.0, 0);
    }

    #[test]
    fn cursor_stays_on_its_row_at_an_exact_wrap_boundary() {
        // width 5 → content width 3; "abc" fills row 0 exactly; cursor at end stays on row 0.
        let l = layout_input("abc", 3, 5);
        assert_eq!(l.total_rows, 1);
        assert_eq!(l.cursor, (0, 3));
    }

    #[test]
    fn input_layout_cache_skips_unchanged_refreshes() {
        let mut cache = InputLayoutCache::default();
        let mut metrics = PerfMetrics::default();
        let mut editor = ed("/task 123");

        cache.refresh_with_metrics(&editor, 40, Some(&mut metrics));
        cache.refresh_with_metrics(&editor, 40, Some(&mut metrics));
        editor.insert_char('x');
        cache.refresh_with_metrics(&editor, 40, Some(&mut metrics));
        cache.refresh_with_metrics(&editor, 20, Some(&mut metrics));

        assert_eq!(metrics.input_layout_refreshes, 3);
        assert_eq!(metrics.input_layout_cache_hits, 1);
    }

    #[test]
    fn perf_metrics_track_batched_event_drains() {
        let mut metrics = PerfMetrics::default();
        note_batch(&mut metrics, 5, true);
        note_batch(&mut metrics, 3, true);
        note_batch(&mut metrics, 4, false);

        assert_eq!(metrics.input_batches, 2);
        assert_eq!(metrics.input_events_total, 8);
        assert_eq!(metrics.input_batch_max, 5);
        assert_eq!(metrics.ui_batches, 1);
        assert_eq!(metrics.ui_events_total, 4);
        assert_eq!(metrics.ui_batch_max, 4);
    }

    #[test]
    fn right_status_drops_by_priority_as_width_shrinks() {
        let full = right_status_text(Some("ctx 34%"), "12m", 100);
        assert_eq!(full, "ctx 34% · 12m");
        // too narrow → drop elapsed first, keep ctx (highest priority)
        assert_eq!(right_status_text(Some("ctx 34%"), "12m", 10), "ctx 34%");
        // nothing fits
        assert_eq!(right_status_text(Some("ctx 34%"), "12m", 3), "");
        // unknown context window → ctx omitted
        assert_eq!(right_status_text(None, "12m", 100), "12m");
    }

    #[test]
    fn tool_end_glyph_reflects_success() {
        let ok = tool_end_line("read_file(x)", true, 1200, "3 lines");
        assert_eq!(ok.spans[0].content, "· ");
        let bad = tool_end_line("edit_file(x)", false, 20, "old_string not found");
        assert_eq!(bad.spans[0].content, "✗ ");
        assert_eq!(bad.spans[0].style.fg, Some(theme::ERROR));
    }

    #[test]
    fn clip_adds_ellipsis_only_when_truncating() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("truncate me", 5), "trun…");
        assert_eq!(clip("x", 0), "");
    }

    #[test]
    fn frame_composes_markdown_status_meter_and_subagent_panel() {
        use super::super::app::{App, UiMsg};
        use crate::events::AgentEvent;
        use crate::provider::TokenUsage;
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let mut app = App::new("gpt-5", ".".to_string(), "/repo".to_string(), Some(200_000), &[]);
        app.running = true;
        app.on_ui(UiMsg::Agent(AgentEvent::Message(
            "**bold** and `code`".to_string(),
        )));
        app.on_ui(UiMsg::Agent(AgentEvent::Usage(TokenUsage {
            prompt_tokens: 68_000,
            completion_tokens: 1_000,
            total_tokens: 69_000,
            cached_tokens: None,
        })));
        app.on_ui(UiMsg::Agent(AgentEvent::SubagentStart {
            id: 0,
            desc: "port editor tests".to_string(),
        }));

        let mut term = Terminal::new(TestBackend::new(80, 20)).unwrap();
        app.refresh_input(80);
        term.draw(|f| draw(f, &mut app)).unwrap();
        let rendered: String = term
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect();

        assert!(rendered.contains("bold"), "assistant markdown missing");
        assert!(rendered.contains("code"));
        assert!(rendered.contains("● "), "assistant bullet missing");
        assert!(rendered.contains("ctx 34%"), "context meter missing: {rendered}");
        assert!(
            rendered.contains("agentj · gpt-5 · ."),
            "footer identity line missing"
        );
        assert!(
            rendered.contains("port editor tests"),
            "subagent panel row missing"
        );
    }

    #[test]
    fn frame_shows_the_slash_popover_above_the_status_row() {
        use super::super::app::App;
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let mut app = App::new("gpt-5", ".".to_string(), "/repo".to_string(), None, &[]);
        for c in "/t".chars() {
            app.on_input(crossterm::event::Event::Key(KeyEvent::new(
                KeyCode::Char(c),
                KeyModifiers::NONE,
            )));
        }
        assert!(app.popover.is_some());

        let mut term = Terminal::new(TestBackend::new(80, 16)).unwrap();
        app.refresh_input(80);
        term.draw(|f| draw(f, &mut app)).unwrap();
        let rendered: String = term
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(rendered.contains("▸ /task"), "selected popover row missing: {rendered}");
        assert!(rendered.contains("wipe + re-key"), "popover summary missing");
    }

    #[test]
    fn max_scroll_counts_wrapped_transcript_rows() {
        let transcript = vec![
            Line::from("1234567890"),
            Line::from("1234567890"),
            Line::from("tiny"),
        ];
        assert_eq!(wrapped_rows_for_line(&transcript[0], 5), 4);
        assert_eq!(transcript_rows(&transcript, 5), 10);
        let mut view = TranscriptView::new(transcript);
        view.ensure_width(5);
        assert_eq!(view.max_scroll(3), 7);
    }
}
