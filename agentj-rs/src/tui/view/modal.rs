//! The centered modals, drawn one at a time over the frame: the Ctrl-P command menu (with the
//! session-token breakdown), the MCP server-status list, and the first-run provider-setup wizard.

use super::human_tokens;
use crate::tui::app::{App, SetupStep};
use crate::tui::theme;
use ratatui::layout::Position;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Padding, Paragraph};
use ratatui::Frame;

/// One breakdown row of the menu's token section. The cache figure is the cache-hit subset of the
/// `in` figure; it's omitted at 0 because most providers simply don't report it.
fn token_row(label: &str, tin: u64, cached: u64, tout: u64, calls: u64) -> String {
    let cache = if cached > 0 {
        format!(" ({} cache)", human_tokens(cached))
    } else {
        String::new()
    };
    format!(
        "  {label:<10} {} in{cache} · {} out · {calls} calls",
        human_tokens(tin),
        human_tokens(tout)
    )
}

/// The Ctrl-P command menu: a small centered modal of session actions/settings.
pub(super) fn render_menu_modal(f: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    use ratatui::layout::Rect;
    let Some(selected) = app.menu else { return };
    let items = [
        format!(
            "Show thinking: {}   (the model's reasoning blocks)",
            if app.show_thinking { "ON " } else { "OFF" }
        ),
        format!(
            "Auto-scroll: {}     (jump to latest on new activity)",
            if app.auto_follow { "ON " } else { "OFF" }
        ),
        format!(
            "Focus: {}           (hide tool calls + thinking)",
            if app.focus { "ON " } else { "OFF" }
        ),
        "Export transcript — write this session to a markdown file".to_string(),
        "MCP servers — connection status".to_string(),
        "Provider setup — endpoint / key / model".to_string(),
    ];
    let mut lines: Vec<Line<'static>> = vec![
        Line::from(Span::styled("Menu", theme::accent_bold())),
        Line::default(),
    ];
    for (i, item) in items.iter().enumerate() {
        let (marker, style) = if i == selected {
            ("› ", theme::accent())
        } else {
            ("  ", theme::muted())
        };
        lines.push(Line::from(vec![
            Span::styled(marker, theme::accent()),
            Span::styled(item.clone(), style),
        ]));
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled("Session tokens", theme::accent_bold())));
    let t = &app.tokens;
    lines.push(Line::from(Span::styled(
        token_row("primary", t.primary_in, t.primary_cached, t.primary_out, t.primary_calls),
        theme::muted(),
    )));
    lines.push(Line::from(Span::styled(
        token_row("subagents", t.sub_in, t.sub_cached, t.sub_out, t.sub_calls),
        theme::muted(),
    )));
    lines.push(Line::from(Span::styled(
        format!(
            "  {:<10} {} in · {} out",
            "total",
            human_tokens(t.total_in()),
            human_tokens(t.total_out())
        ),
        theme::dim(),
    )));
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        "↑↓ move · Enter select · Esc/Ctrl-P close",
        theme::dim(),
    )));

    let mw = 68.min(area.width.saturating_sub(4)).max(24);
    let mh = (lines.len() as u16 + 3).min(area.height);
    let rect = Rect {
        x: area.x + area.width.saturating_sub(mw) / 2,
        y: area.y + area.height.saturating_sub(mh) / 2,
        width: mw,
        height: mh,
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::accent())
        .padding(Padding::new(2, 2, 1, 0));
    f.render_widget(Clear, rect);
    f.render_widget(Paragraph::new(lines).block(block), rect);
}

/// A centered modal listing each MCP server's connect result (tools on success, the captured error on
/// failure), so startup problems are surfaced cleanly instead of spewed to the terminal.
pub(super) fn render_mcp_modal(f: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    use ratatui::layout::Rect;
    let mw = 78.min(area.width.saturating_sub(4)).max(24);
    let err_width = (mw as usize).saturating_sub(24); // box minus borders/padding/name column

    let mut lines: Vec<Line<'static>> = vec![
        Line::from(Span::styled("MCP servers", theme::accent_bold())),
        Line::default(),
    ];
    for s in &app.mcp_status {
        use crate::mcp::client::McpOutcome;
        lines.push(match &s.outcome {
            McpOutcome::Ok(n) => Line::from(vec![
                Span::styled("✓ ", theme::ok()),
                Span::styled(format!("{:<16}", trunc(&s.name, 16)), theme::muted()),
                Span::styled(format!("{n} tool{}", if *n == 1 { "" } else { "s" }), theme::dim()),
            ]),
            McpOutcome::NeedsAuth => Line::from(vec![
                Span::styled("✎ ", theme::accent()),
                Span::styled(format!("{:<16}", trunc(&s.name, 16)), theme::muted()),
                Span::styled(format!("needs authorization — /mcp login {}", s.name), theme::dim()),
            ]),
            McpOutcome::Err(e) => Line::from(vec![
                Span::styled("✗ ", theme::err()),
                Span::styled(format!("{:<16}", trunc(&s.name, 16)), theme::muted()),
                Span::styled(trunc(e, err_width), theme::dim()),
            ]),
        });
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        "Any key: dismiss   ·   ✎ servers authorize once with /mcp login <name>",
        theme::dim(),
    )));

    let mh = (lines.len() as u16 + 3).min(area.height);
    let rect = Rect {
        x: area.x + area.width.saturating_sub(mw) / 2,
        y: area.y + area.height.saturating_sub(mh) / 2,
        width: mw,
        height: mh,
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::accent())
        .padding(Padding::new(2, 2, 1, 0));
    f.render_widget(Clear, rect);
    f.render_widget(Paragraph::new(lines).block(block), rect);
}

/// Truncate to `max` chars with an ellipsis when it doesn't fit.
fn trunc(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
    }
}

/// Draw the provider-setup wizard as a centered modal form: one row per field, the active one showing
/// the live input (the key masked) with the terminal cursor placed in it.
pub(super) fn render_setup_modal(f: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    use ratatui::layout::Rect;
    let Some(w) = app.setup.as_ref() else { return };

    let cur = step_index(w.step);
    let masked_key = "•".repeat(w.api_key.chars().count());
    let fields = [
        (SetupStep::Provider, "Provider", w.provider.map(provider_label).unwrap_or_default()),
        (SetupStep::BaseUrl, "Base URL", w.base_url.clone()),
        (SetupStep::ApiKey, "API key", masked_key),
        (SetupStep::Model, "Model", String::new()),
    ];

    let mut lines: Vec<Line<'static>> = vec![
        Line::from(Span::styled("Set up a provider", theme::accent_bold())),
        Line::default(),
    ];
    let mut cursor: Option<(u16, u16)> = None; // (row, col) within the inner area
    for (i, (step, label, stored)) in fields.iter().enumerate() {
        let active = i == cur;
        let value = if active {
            let t = app.editor.text();
            if *step == SetupStep::ApiKey {
                "•".repeat(t.chars().count())
            } else {
                t.to_string()
            }
        } else if i < cur {
            stored.clone()
        } else {
            String::new()
        };
        let marker = if active { "› " } else { "  " };
        let label_style = if active { theme::accent() } else { theme::dim() };
        let prefix = format!("{marker}{label:<9} "); // 2 + 9 + 1 = 12 cols before the value
        if active {
            cursor = Some((lines.len() as u16, prefix.chars().count() as u16 + value.chars().count() as u16));
        }
        lines.push(Line::from(vec![
            Span::styled(prefix, label_style),
            Span::raw(value),
        ]));
        if active && *step == SetupStep::Provider {
            lines.push(Line::from(Span::styled("            1) azure    2) custom", theme::dim())));
        }
    }
    lines.push(Line::default());
    if let Some(err) = &w.error {
        lines.push(Line::from(Span::styled(format!("✗ {err}"), theme::err())));
    }
    lines.push(Line::from(Span::styled("Enter: continue    Esc: cancel", theme::dim())));

    let mw = 66.min(area.width.saturating_sub(4)).max(20);
    let mh = (lines.len() as u16 + 3).min(area.height); // + top/bottom border + 1 top padding row
    let rect = Rect {
        x: area.x + area.width.saturating_sub(mw) / 2,
        y: area.y + area.height.saturating_sub(mh) / 2,
        width: mw,
        height: mh,
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::accent())
        .padding(Padding::new(2, 2, 1, 0));
    let inner = block.inner(rect);
    f.render_widget(Clear, rect);
    f.render_widget(Paragraph::new(lines).block(block), rect);
    if let Some((r, c)) = cursor {
        f.set_cursor_position(Position::new(
            (inner.x + c).min(inner.x + inner.width.saturating_sub(1)),
            (inner.y + r).min(inner.y + inner.height.saturating_sub(1)),
        ));
    }
}

fn step_index(s: SetupStep) -> usize {
    match s {
        SetupStep::Provider => 0,
        SetupStep::BaseUrl => 1,
        SetupStep::ApiKey => 2,
        SetupStep::Model => 3,
    }
}

fn provider_label(p: crate::model::Provider) -> String {
    p.as_str().to_string()
}
