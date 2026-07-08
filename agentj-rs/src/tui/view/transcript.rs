//! The scrollback transcript: [`TranscriptView`] (pre-rendered lines + cumulative wrapped-row
//! counts), the line builders that feed it ([`assistant_block`], [`tool_end_line`]), and the
//! display sanitizing that keeps raw control bytes off the terminal.

use super::fmt_ms;
use crate::tui::markdown::render_markdown;
use crate::tui::theme;
use crate::tui::wrap;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span, Text};

/// What a transcript line is, so the renderer can group your prompts and agentj's replies into
/// tinted "cards", label each block by type, and filter the machinery. `Tool` is a tool-call line;
/// `Note` is lifecycle chatter (`»`); `Thinking` is the model's reasoning. Tool + Thinking hide
/// under Focus.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Plain,
    User,
    Assistant,
    Tool,
    Note,
    Thinking,
}

impl LineKind {
    /// The per-block type label shown in the gutter (`None` for structural `Plain` rows — blank
    /// separators between blocks, which carry no type of their own).
    pub(super) fn label(self) -> Option<&'static str> {
        match self {
            LineKind::User => Some("you"),
            LineKind::Assistant => Some("agentj"),
            LineKind::Tool => Some("tool"),
            LineKind::Note => Some("note"),
            LineKind::Thinking => Some("thinking"),
            LineKind::Plain => None,
        }
    }

    /// Whether a line of this kind is filtered out for the given display toggles. Focus hides all
    /// the machinery (tool calls, thinking); the thinking toggle hides just its own kind.
    fn hidden(self, hide_thinking: bool, focus: bool) -> bool {
        match self {
            LineKind::Tool => focus,
            LineKind::Thinking => hide_thinking || focus,
            _ => false,
        }
    }

    /// A card kind's `(left-bar color, background tint)`, or `None` for plain lines (no fill).
    fn card_colors(self) -> Option<(Color, Color)> {
        match self {
            LineKind::User => Some((theme::user_bar(), theme::user_bg())),
            LineKind::Assistant => Some((theme::assistant_bar(), theme::assistant_bg())),
            _ => None,
        }
    }
}

/// Columns reserved on the left of every transcript row: the card's bar + a space (blank for plain
/// lines). Uniform so the wrap width is the same for every line and the scroll math stays simple.
pub(super) const GUTTER: usize = 2;

/// Width of the per-block type-label column, left of the card gutter. Fits the longest label
/// ("thinking"); the label is drawn once, on the first row of each block.
pub(super) const LABEL_W: usize = 8;

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

/// The exact physical rows to draw for the transcript: wrap each window line at `text_width` (the
/// content width already net of the card GUTTER), decorate it per its kind (a tinted band + left
/// bar for User/Assistant cards, a blank gutter for plain lines), skip the `intra` rows scrolled
/// past at the top, and take `viewport` rows. Owning the wrap here (vs. ratatui's `Wrap`) is what
/// keeps the wrap, the scroll math, and the screen-based selection in agreement.
pub(super) fn visible_transcript_rows(
    window: &[Line<'static>],
    kinds: &[LineKind],
    first_is_block_start: bool,
    text_width: u16,
    viewport: u16,
    intra: u16,
) -> Text<'static> {
    let width = text_width.max(1) as usize;
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut skip = intra as usize;
    'outer: for (j, (line, &kind)) in window.iter().zip(kinds).enumerate() {
        // A block = a maximal run of same-kind logical lines. The type label is drawn once, on the
        // first physical row of the block's first line (carried to the first NON-skipped row so it
        // survives a partial scroll into the block).
        let block_start = if j == 0 { first_is_block_start } else { kind != kinds[j - 1] };
        let mut label_pending = if block_start { kind.label() } else { None };
        for row in wrap::wrap_line(line, width) {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            if out.len() >= viewport as usize {
                break 'outer;
            }
            out.push(decorate_row(&row.cells, kind, width, label_pending.take()));
        }
    }
    Text::from(out)
}

/// Turn one wrapped physical row into a drawable line: a left type-label column (the label only on
/// a block's first row), then card kinds get a `▌` bar and a background tint padded to the full text
/// width (a solid band) while plain kinds get a two-space gutter and no fill. Selection reads the
/// rendered buffer, so this display-only decoration never disturbs the character math.
fn decorate_row(
    cells: &[(char, Style)],
    kind: LineKind,
    text_width: usize,
    label: Option<&str>,
) -> Line<'static> {
    let mut out: Vec<(char, Style)> = Vec::with_capacity(cells.len() + LABEL_W + GUTTER + 4);
    // Label column: the type label (dim, right-aligned against the gutter) on a block's first row,
    // blank otherwise.
    let text = label.unwrap_or("");
    let shown: String = text.chars().take(LABEL_W).collect();
    for _ in 0..LABEL_W.saturating_sub(shown.chars().count()) {
        out.push((' ', theme::dim()));
    }
    for c in shown.chars() {
        out.push((c, theme::dim()));
    }
    // Card gutter + body.
    match kind.card_colors() {
        Some((bar, bg)) => {
            let bar_style = Style::default().fg(bar).bg(bg);
            let bg_style = Style::default().bg(bg);
            out.push(('▌', bar_style));
            out.push((' ', bg_style));
            for &(c, st) in cells {
                out.push((c, st.bg(bg)));
            }
            for _ in cells.len()..text_width {
                out.push((' ', bg_style)); // pad the band to the full width
            }
        }
        None => {
            out.push((' ', Style::default()));
            out.push((' ', Style::default()));
            out.extend_from_slice(cells);
        }
    }
    wrap::cells_to_line(&out)
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
    /// Every line ever pushed, with its kind — the master copy that survives filtering, so the
    /// thinking and Focus toggles collapse/restore rows retroactively.
    all: Vec<(Line<'static>, LineKind)>,
    /// The visible lines (filtered per the toggles). Everything else reads this.
    lines: Vec<Line<'static>>,
    /// Kind of each visible line, index-aligned with `lines` — the renderer's card/plain decision.
    kinds: Vec<LineKind>,
    /// `row_prefix[i]` = total wrapped rows of `lines[0..i]`; line `i` begins at wrapped row
    /// `row_prefix[i]`, and the whole transcript is `*row_prefix.last()`. Kept in sync incrementally.
    row_prefix: Vec<usize>,
    cached_width: u16,
    hide_thinking: bool,
    focus: bool,
}

impl TranscriptView {
    pub fn new(lines: Vec<Line<'static>>) -> Self {
        let lines: Vec<Line<'static>> = lines.into_iter().map(sanitize_line).collect();
        Self {
            all: lines.iter().map(|l| (l.clone(), LineKind::Plain)).collect(),
            kinds: vec![LineKind::Plain; lines.len()],
            lines,
            row_prefix: vec![0],
            cached_width: 0,
            hide_thinking: false,
            focus: false,
        }
    }

    /// Rebuild the visible line/kind lists from the master copy under the current toggles, and
    /// force `ensure_width` to recompute the prefix sums.
    fn rebuild_visible(&mut self) {
        self.lines.clear();
        self.kinds.clear();
        for (line, kind) in &self.all {
            if !kind.hidden(self.hide_thinking, self.focus) {
                self.lines.push(line.clone());
                self.kinds.push(*kind);
            }
        }
        self.cached_width = 0;
        self.row_prefix = vec![0];
    }

    /// Show or hide the model's `thinking` rows — retroactively.
    pub fn set_hide_thinking(&mut self, hide: bool) {
        if self.hide_thinking != hide {
            self.hide_thinking = hide;
            self.rebuild_visible();
        }
    }

    /// The whole transcript as labeled markdown (for export): a `### <label>` header at each block
    /// boundary, then the block's line text. Includes rows currently filtered out of the view.
    pub fn export_markdown(&self) -> String {
        let mut out = String::new();
        let mut prev: Option<LineKind> = None;
        for (line, kind) in &self.all {
            let text: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
            if Some(*kind) != prev {
                if let Some(label) = kind.label() {
                    out.push_str(&format!("\n### {label}\n"));
                }
                prev = Some(*kind);
            }
            out.push_str(&text);
            out.push('\n');
        }
        out
    }

    /// Focus mode: hide the machinery (tool calls + thinking), leaving just the conversation.
    pub fn set_focus(&mut self, focus: bool) {
        if self.focus != focus {
            self.focus = focus;
            self.rebuild_visible();
        }
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
    /// the index of the first line, the line slice and its parallel kind slice (cloned/borrowed by
    /// the caller, not the whole transcript), the intra-line wrapped-row offset scrolled past at the
    /// top, and whether the first window line begins a block (so the type label is placed correctly
    /// even when the window starts mid-transcript). O(log n + viewport).
    pub fn window(
        &self,
        scroll: u16,
        viewport: u16,
    ) -> (usize, &[Line<'static>], &[LineKind], u16, bool) {
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
        let first_is_block_start =
            first == 0 || self.kinds.get(first) != self.kinds.get(first.wrapping_sub(1));
        (first, &self.lines[first..end], &self.kinds[first..end], intra, first_is_block_start)
    }

    pub fn push(&mut self, line: Line<'static>) {
        self.push_kind(line, LineKind::Plain);
    }

    /// Push a line tagged with its kind (user prompt, agentj reply, tool call, …). The kind drives
    /// both the card decoration and the toggle filtering.
    pub fn push_kind(&mut self, line: Line<'static>, kind: LineKind) {
        let line = sanitize_line(line);
        self.all.push((line.clone(), kind));
        if kind.hidden(self.hide_thinking, self.focus) {
            return;
        }
        if self.cached_width != 0 && self.row_prefix.len() == self.lines.len() + 1 {
            let rows = wrapped_rows_for_line(&line, self.cached_width);
            self.row_prefix.push(self.total_rows() + rows);
        }
        self.lines.push(line);
        self.kinds.push(kind);
    }

    pub fn extend_kind<I>(&mut self, iter: I, kind: LineKind)
    where
        I: IntoIterator<Item = Line<'static>>,
    {
        for line in iter {
            self.push_kind(line, kind);
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
