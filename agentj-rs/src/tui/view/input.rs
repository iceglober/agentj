//! The input box, wrapped char-exact: [`layout_input`] pre-wraps every visual row (so the cursor
//! math is authoritative and whitespace-only lines render), and [`InputLayoutCache`] memoizes the
//! layout per editor revision + width.

#[cfg(test)]
use super::perf::PerfMetrics;
use crate::commands::{classify, TokenClass, SLASH_COMMANDS};
use crate::tui::editor::Editor;
use crate::tui::theme;
use ratatui::text::{Line, Span, Text};

pub const MAX_INPUT_ROWS: u16 = 8;

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
