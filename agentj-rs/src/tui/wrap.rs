//! agentj-owned word-wrapping for the transcript. We materialize the visible window's physical rows
//! ourselves instead of leaning on ratatui's `Wrap` widget, so three things agree exactly: what's
//! drawn, the scroll-row math (`row_prefix`), and the mouse→character mapping that text selection
//! needs. Each physical row is tagged with the character range it covers in its logical line, which is
//! what lets a click land on the right character and a copy pull the right text.
use ratatui::style::Style;
use ratatui::text::{Line, Span};

/// One on-screen row produced by wrapping a logical line. `char_start` is the offset of the first
/// cell within the logical line's concatenated text; a cell at column `c` is logical char
/// `char_start + c`. A consumed break-space between rows leaves a one-char gap between rows' ranges —
/// the space is still in the logical text (so copy includes it) but isn't drawn.
#[derive(Clone, Debug, PartialEq)]
pub struct PhysRow {
    pub cells: Vec<(char, Style)>,
    pub char_start: usize,
}

/// Flatten a logical line to `(char, style)` cells, one per character, in reading order. The logical
/// char index of a cell is its position in this vec.
pub fn line_cells(line: &Line) -> Vec<(char, Style)> {
    line.spans
        .iter()
        .flat_map(|s| {
            let style = s.style;
            s.content.chars().map(move |c| (c, style))
        })
        .collect()
}

/// Greedy word-wrap of a logical line to `width` columns: break at the last space that fits, consume
/// that space (so continuation rows don't start with it), and hard-split a word longer than `width`.
/// An empty line yields a single empty row so it still occupies one screen row.
pub fn wrap_cells(cells: &[(char, Style)], width: usize) -> Vec<PhysRow> {
    let width = width.max(1);
    let n = cells.len();
    if n == 0 {
        return vec![PhysRow {
            cells: Vec::new(),
            char_start: 0,
        }];
    }
    let mut rows = Vec::new();
    let mut i = 0;
    while i < n {
        if n - i <= width {
            rows.push(PhysRow {
                cells: cells[i..n].to_vec(),
                char_start: i,
            });
            break;
        }
        // Must break within [i, i+width]. Prefer the last space at or before the row cap so the space
        // becomes the boundary; otherwise hard-break a too-long word at the cap.
        let cap = i + width;
        let brk = (i..=cap).rev().find(|&k| cells[k].0 == ' ');
        match brk {
            Some(sp) if sp > i => {
                rows.push(PhysRow {
                    cells: cells[i..sp].to_vec(),
                    char_start: i,
                });
                i = sp + 1; // consume the break space
            }
            _ => {
                rows.push(PhysRow {
                    cells: cells[i..cap].to_vec(),
                    char_start: i,
                });
                i = cap;
            }
        }
    }
    rows
}

/// Wrap a whole logical line.
pub fn wrap_line(line: &Line, width: usize) -> Vec<PhysRow> {
    wrap_cells(&line_cells(line), width)
}

/// How many physical rows a logical line occupies at `content_width`.
pub fn rows_for_line(line: &Line, content_width: u16) -> usize {
    wrap_line(line, content_width.max(1) as usize).len()
}

/// Rebuild a drawable `Line` from cells, coalescing runs of identical style into spans.
pub fn cells_to_line(cells: &[(char, Style)]) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut buf = String::new();
    let mut style: Option<Style> = None;
    for &(ch, st) in cells {
        if style != Some(st) {
            if let Some(prev) = style {
                spans.push(Span::styled(std::mem::take(&mut buf), prev));
            }
            style = Some(st);
        }
        buf.push(ch);
    }
    if let Some(st) = style {
        spans.push(Span::styled(buf, st));
    }
    Line::from(spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(cells: &[(char, Style)]) -> String {
        cells.iter().map(|(c, _)| *c).collect()
    }

    fn cells(s: &str) -> Vec<(char, Style)> {
        s.chars().map(|c| (c, Style::default())).collect()
    }

    #[test]
    fn breaks_at_spaces_and_consumes_them() {
        let rows = wrap_cells(&cells("hello world foo"), 6);
        // "hello " -> "hello"(0..5), "world "(6..11), "foo"(12..15); break spaces consumed.
        assert_eq!(
            rows.iter().map(|r| plain(&r.cells)).collect::<Vec<_>>(),
            ["hello", "world", "foo"]
        );
        assert_eq!(
            rows.iter().map(|r| r.char_start).collect::<Vec<_>>(),
            [0, 6, 12]
        );
    }

    #[test]
    fn hard_splits_a_word_longer_than_width() {
        let rows = wrap_cells(&cells("supercalifragilistic"), 6);
        assert_eq!(rows[0].char_start, 0);
        assert_eq!(rows[1].char_start, 6);
        assert_eq!(
            rows.iter().map(|r| r.cells.len()).sum::<usize>(),
            20,
            "no chars lost"
        );
        assert_eq!(plain(&rows[0].cells), "superc");
    }

    #[test]
    fn char_offsets_round_trip_a_column_to_a_logical_index() {
        let rows = wrap_cells(&cells("hello world foo"), 6);
        // column 2 of row 1 ("world") is logical char index 6+2 = 8 -> 'r'
        let row = &rows[1];
        assert_eq!(row.char_start + 2, 8);
        assert_eq!(row.cells[2].0, 'r');
    }

    #[test]
    fn empty_line_occupies_one_row() {
        assert_eq!(
            wrap_cells(&[], 10),
            vec![PhysRow {
                cells: vec![],
                char_start: 0
            }]
        );
    }

    #[test]
    fn cells_to_line_coalesces_same_style_runs() {
        let line = cells_to_line(&cells("abc"));
        assert_eq!(line.spans.len(), 1);
        assert_eq!(line.spans[0].content.as_ref(), "abc");
    }
}
