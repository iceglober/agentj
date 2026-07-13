//! Mouse selection: a drag in screen cells, its auto-scroll at the transcript edges, and the copy
//! read-back from the rendered frame.

use super::App;

/// A drag selection in absolute SCREEN cells (col, row). Screen-based rather than tied to the
/// transcript data model, so it can cover ANY rendered content — the transcript, a modal, a panel.
/// The text is read back from the rendered terminal buffer (`App::screen_rows`).
#[derive(Clone, Copy)]
pub struct Selection {
    pub anchor: (u16, u16),
    pub cursor: (u16, u16),
}

impl Selection {
    /// (top-left, bottom-right) endpoints ordered by (row, col).
    pub fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        let key = |p: (u16, u16)| (p.1, p.0);
        if key(self.anchor) <= key(self.cursor) {
            (self.anchor, self.cursor)
        } else {
            (self.cursor, self.anchor)
        }
    }
    pub fn is_click(&self) -> bool {
        self.anchor == self.cursor
    }
}

/// The transcript's top screen row and height from the last frame, so a drag past its top/bottom
/// edge can auto-scroll while selecting.
#[derive(Clone, Copy)]
pub struct TranscriptGeom {
    pub y: u16,
    pub viewport: u16,
}

impl App {
    /// When a drag reaches the transcript's top/bottom edge, scroll it one row so the selection can
    /// extend beyond the viewport — and shift the anchor to track its text (until it scrolls off).
    /// Only when no modal is up (modals are static and cover the transcript).
    pub(super) fn autoscroll_selection(&mut self, row: u16) {
        if self.setup.is_some() || self.mcp_modal_open() {
            return;
        }
        let Some(g) = self.tgeom else { return };
        let bottom = g.y + g.viewport.saturating_sub(1);
        let delta: i32 = if row <= g.y {
            -1
        } else if row >= bottom {
            1
        } else {
            return;
        };
        self.follow = false;
        self.scroll = if delta < 0 {
            self.scroll.saturating_sub(1)
        } else {
            self.scroll.saturating_add(1)
        };
        // Content moved by `delta`; keep the anchor on the same text if it's within the transcript.
        if let Some(sel) = self.selection.as_mut() {
            let (ax, ay) = sel.anchor;
            if ay >= g.y && ay <= bottom {
                let ny = (ay as i32 - delta).clamp(g.y as i32, bottom as i32) as u16;
                sel.anchor = (ax, ny);
            }
        }
    }

    /// The selected text, read from the last rendered frame's screen rows so it's exactly what's on
    /// screen (any widget). Rows join with newlines; trailing padding is trimmed.
    pub fn selected_screen_text(&self, sel: Selection) -> String {
        let ((sx, sy), (ex, ey)) = sel.ordered();
        let mut out: Vec<String> = Vec::new();
        for y in sy..=ey {
            let chars: Vec<char> = self
                .screen_rows
                .get(y as usize)
                .map(|s| s.chars().collect())
                .unwrap_or_default();
            let x0 = if y == sy { sx as usize } else { 0 };
            let x1 = if y == ey { ex as usize } else { chars.len() };
            let x0 = x0.min(chars.len());
            let x1 = x1.min(chars.len()).max(x0);
            out.push(
                chars[x0..x1]
                    .iter()
                    .collect::<String>()
                    .trim_end()
                    .to_string(),
            );
        }
        out.join("\n")
    }
}
