//! Colors, glyphs, and the small styling helpers the TUI draws with. ANSI-16 only, so the user's
//! terminal palette is respected; no background fills (they read as broken across light/dark themes).

use ratatui::style::{Color, Modifier, Style};

pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub const ACCENT: Color = Color::Cyan; // spinner, exact slash command, headings, user prompt glyph
pub const DIM: Color = Color::DarkGray; // chrome: bullets, tool lines, notes, dividers, hints
pub const MUTED: Color = Color::Gray; // secondary text a step above DIM
pub const ERROR: Color = Color::Red; // errors, unknown slash command, ✗
pub const SUCCESS: Color = Color::Green; // ✓ (subagent/tool ok)
pub const WARN: Color = Color::Yellow; // context meter near full
pub const CODE: Color = Color::Yellow; // inline code
pub const CODE_BLOCK: Color = Color::Gray; // fenced code body (verbatim)

pub fn dim() -> Style {
    Style::default().fg(DIM)
}
pub fn muted() -> Style {
    Style::default().fg(MUTED)
}
pub fn accent() -> Style {
    Style::default().fg(ACCENT)
}
pub fn accent_bold() -> Style {
    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
}
/// Highlight for selected transcript text. REVERSED (swap fg/bg) rather than a background color, to
/// stay within the palette-respecting, no-background-color theme and show over any content.
pub fn selection_style() -> Style {
    Style::default().add_modifier(Modifier::REVERSED)
}
pub fn err() -> Style {
    Style::default().fg(ERROR)
}
pub fn ok() -> Style {
    Style::default().fg(SUCCESS)
}

/// Accent while a turn is running, gray at rest.
pub fn pulse_color(running: bool) -> Color {
    if running {
        ACCENT
    } else {
        MUTED
    }
}

pub fn divider_color() -> Color {
    DIM
}

// Message-card treatment (the "Cards" transcript style). These are the ONE deliberate exception to
// the no-background-fills rule at the top of this file: a subtle tinted band + colored left bar
// groups your prompts and agentj's replies, with tool calls rendered plainly between.
// The tints are truecolor and tuned for a DARK terminal — on a light background they read as dark
// boxes (the reason the rest of the theme avoids fills). RGB so the warm-you / cool-agent contrast
// survives regardless of the user's ANSI-16 palette.
pub fn user_bar() -> Color {
    Color::Rgb(224, 138, 76) // warm — your prompts
}
pub fn user_bg() -> Color {
    Color::Rgb(34, 28, 23)
}
pub fn assistant_bar() -> Color {
    Color::Rgb(108, 182, 255) // cool — agentj
}
pub fn assistant_bg() -> Color {
    Color::Rgb(21, 27, 37)
}

pub fn sparkle() -> &'static str {
    "·"
}
