//! The scrollback transcript: [`TranscriptView`] (pre-rendered lines + cumulative wrapped-row
//! counts), the line builders that feed it ([`assistant_block`], [`tool_end_line`]), and the
//! display sanitizing that keeps raw control bytes off the terminal.

use super::fmt_ms;
use crate::tui::markdown::render_markdown;
use crate::tui::theme;
use crate::tui::wrap;
use ratatui::text::{Line, Span, Text};

/// Make external text (tool output, file contents, model text) safe to draw. Ratatui models a raw
/// `\t` as ONE cell, but the terminal advances to a tab stop, so every character after a tab lands
/// cells to the right of where ratatui thinks it is — leaving stale glyphs pinned to the screen that
/// no redraw (not even a full `Clear`) overwrites, because ratatui's buffer never knew about them.
/// ESC/CR/backspace corrupt worse. Tabs expand to 4-col stops; other control chars are dropped. The
/// model still sees the original text — only the on-screen copy is cleaned.
pub(super) fn sanitize_display(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    let mut col = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\t' => {
                let n = 4 - (col % 4);
                for _ in 0..n {
                    out.push(' ');
                }
                col += n;
            }
            // Drop a whole escape sequence, not just the ESC byte, so ANSI color codes in tool output
            // (`\x1b[31m…`) don't leave `[31m` litter. CSI = `ESC [` params up to a final byte @..~.
            '\x1b' => {
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                } else {
                    chars.next();
                }
            }
            c if c.is_control() => {} // CR, BS, stray NL within a span, …
            c => {
                out.push(c);
                col += 1;
            }
        }
    }
    out
}

/// Sanitize a line's span contents in place. A fast byte scan skips the common all-clean case.
fn sanitize_line(mut line: Line<'static>) -> Line<'static> {
    for span in &mut line.spans {
        if span.content.bytes().any(|b| b < 0x20 || b == 0x7f) {
            span.content = sanitize_display(&span.content).into();
        }
    }
    line
}

/// An assistant message rendered as markdown, with a single dim bullet on the first line and a
/// two-space indent on the rest so one message reads as one block. Blank separator lines stay truly
/// empty: a whitespace-only line under `Wrap` renders as TWO rows (and breaks the row accounting),
/// which used to double every paragraph gap.
pub fn assistant_block(text: &str) -> Vec<Line<'static>> {
    let mut lines = render_markdown(text);
    if lines.is_empty() {
        lines.push(Line::default());
    }
    for (i, line) in lines.iter_mut().enumerate() {
        let prefix = if i == 0 {
            Span::styled("● ", theme::dim())
        } else if line.spans.is_empty() {
            continue;
        } else {
            Span::raw("  ")
        };
        line.spans.insert(0, prefix);
    }
    lines
}

/// A finished tool call: dim `·` when it succeeded, red `✗` when it failed. `batched` marks a call
/// the model returned in the SAME response as the previous one (one round-trip, several calls) —
/// drawn `+` so batching is visible in the transcript.
pub fn tool_end_line(tool: &str, ok: bool, elapsed_ms: u128, summary: &str, batched: bool) -> Line<'static> {
    let (glyph, glyph_style) = if !ok {
        ("✗", theme::err())
    } else if batched {
        ("+", theme::dim())
    } else {
        ("·", theme::dim())
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

/// Physical rows a logical line takes at `content_width` (the true text-area width, already net of
/// padding). Uses agentj's own word-wrap so this count matches what's drawn and the selection map
/// exactly. (The old char-wrap estimate subtracted padding a second time, drifting scroll from render.)
pub(super) fn wrapped_rows_for_line(line: &Line<'_>, content_width: u16) -> usize {
    wrap::rows_for_line(line, content_width)
}

/// The exact physical rows to draw for the transcript: wrap the window's logical lines ourselves,
/// skip the `intra` rows scrolled past at the top, take `viewport` rows, and reverse-video any cells
/// inside the selection. Owning the wrap here (vs. ratatui's `Wrap`) is what makes the highlight land
/// on the same characters the selection map computed.
pub(super) fn visible_transcript_rows(
    window: &[Line<'static>],
    content_width: u16,
    viewport: u16,
    intra: u16,
) -> Text<'static> {
    let width = content_width.max(1) as usize;
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut skip = intra as usize;
    'outer: for line in window {
        for row in wrap::wrap_line(line, width) {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            if out.len() >= viewport as usize {
                break 'outer;
            }
            out.push(wrap::cells_to_line(&row.cells));
        }
    }
    Text::from(out)
}

#[cfg(test)]
pub(super) fn transcript_rows(lines: &[Line<'_>], width: u16) -> usize {
    lines
        .iter()
        .map(|line| wrapped_rows_for_line(line, width))
        .sum()
}

/// The scrollback buffer: pre-rendered lines plus cumulative wrapped-row counts, so a dirty frame
/// clones only the visible window instead of the whole (unbounded) transcript.
pub struct TranscriptView {
    /// Every line ever pushed, with its steering tag — the master copy that survives filtering,
    /// so the steering toggle collapses/restores rows retroactively.
    all: Vec<(Line<'static>, bool)>,
    /// The visible lines (steering filtered out while hidden). Everything else reads this.
    lines: Vec<Line<'static>>,
    /// `row_prefix[i]` = total wrapped rows of `lines[0..i]`; line `i` begins at wrapped row
    /// `row_prefix[i]`, and the whole transcript is `*row_prefix.last()`. Kept in sync incrementally.
    row_prefix: Vec<usize>,
    cached_width: u16,
    hide_steering: bool,
}

impl TranscriptView {
    pub fn new(lines: Vec<Line<'static>>) -> Self {
        let lines: Vec<Line<'static>> = lines.into_iter().map(sanitize_line).collect();
        Self {
            all: lines.iter().map(|l| (l.clone(), false)).collect(),
            lines,
            row_prefix: vec![0],
            cached_width: 0,
            hide_steering: false,
        }
    }

    /// Show or hide steering rows — retroactively: already-pushed rows collapse or reappear.
    pub fn set_hide_steering(&mut self, hide: bool) {
        if self.hide_steering == hide {
            return;
        }
        self.hide_steering = hide;
        self.lines = self
            .all
            .iter()
            .filter(|(_, steering)| !(hide && *steering))
            .map(|(l, _)| l.clone())
            .collect();
        // Force ensure_width to rebuild the prefix sums for the new line set.
        self.cached_width = 0;
        self.row_prefix = vec![0];
    }

    fn total_rows(&self) -> usize {
        *self.row_prefix.last().unwrap_or(&0)
    }

    pub fn ensure_width(&mut self, width: u16) {
        // Rebuild the prefix sums on a width change, or if pushes happened before a width was known.
        if self.cached_width != width || self.row_prefix.len() != self.lines.len() + 1 {
            self.cached_width = width;
            self.row_prefix.clear();
            self.row_prefix.push(0);
            let mut acc = 0;
            for line in &self.lines {
                acc += wrapped_rows_for_line(line, width);
                self.row_prefix.push(acc);
            }
        }
    }

    pub fn max_scroll(&self, viewport: u16) -> u16 {
        self.total_rows().saturating_sub(viewport as usize) as u16
    }

    /// The window of logical lines needed to fill `viewport` rows starting at wrapped-row `scroll`:
    /// the index of the first line, the line slice (cloned by the caller, not the whole transcript),
    /// and the intra-line wrapped-row offset scrolled past at the top. O(log n + viewport).
    pub fn window(&self, scroll: u16, viewport: u16) -> (usize, &[Line<'static>], u16) {
        let scroll = scroll as usize;
        let first = self
            .row_prefix
            .partition_point(|&r| r <= scroll)
            .saturating_sub(1)
            .min(self.lines.len().saturating_sub(1));
        let intra = (scroll.saturating_sub(self.row_prefix[first])) as u16;
        let need = intra as usize + viewport as usize;
        let mut taken = 0;
        let mut end = first;
        while end < self.lines.len() && taken < need {
            taken += wrapped_rows_for_line(&self.lines[end], self.cached_width.max(1));
            end += 1;
        }
        (first, &self.lines[first..end], intra)
    }

    pub fn push(&mut self, line: Line<'static>) {
        self.push_tagged(line, false);
    }

    /// Push a supervisor-steering row: always retained in the master copy, visible only while
    /// steering is shown.
    pub fn push_steering(&mut self, line: Line<'static>) {
        self.push_tagged(line, true);
    }

    fn push_tagged(&mut self, line: Line<'static>, steering: bool) {
        let line = sanitize_line(line);
        self.all.push((line.clone(), steering));
        if steering && self.hide_steering {
            return;
        }
        if self.cached_width != 0 && self.row_prefix.len() == self.lines.len() + 1 {
            let rows = wrapped_rows_for_line(&line, self.cached_width);
            self.row_prefix.push(self.total_rows() + rows);
        }
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

    /// All transcript text joined with newlines (for assertions).
    #[cfg(test)]
    pub fn plain(&self) -> String {
        self.lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }
}
