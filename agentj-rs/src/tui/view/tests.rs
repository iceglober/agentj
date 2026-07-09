use super::input::{layout_input, InputLayoutCache, MAX_INPUT_ROWS};
use super::status::right_status_text;
use super::transcript::{sanitize_display, transcript_rows, wrapped_rows_for_line};
use super::tray::{clip, fmt_mmss, jobs_panel, subagent_panel, subagent_panel_rows};
use super::{
    assistant_block, dim_line, draw, note_batch, rail_connector, tool_end_line, PerfMetrics,
    TranscriptView,
};
use crate::tui::app::App;
use crate::tui::editor::Editor;
use crate::tui::theme;
use ratatui::text::Line;
use std::time::{Duration, Instant};

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
fn assistant_block_keeps_paragraph_separators_truly_empty() {
    let lines = assistant_block("para one\n\npara two");
    assert_eq!(row_text(&lines[0]), "● para one");
    assert!(
        lines[1].spans.is_empty(),
        "separator must stay empty — an indented whitespace line renders as two rows under Wrap"
    );
    assert_eq!(row_text(&lines[2]), "  para two");
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
fn tool_end_glyph_reflects_success_and_batching() {
    let ok = tool_end_line("read_file(x)", true, 1200, "3 lines", false);
    assert_eq!(ok.spans[0].content, "· ");
    let batched = tool_end_line("edit_file(y)", true, 5, "edited", true);
    assert_eq!(batched.spans[0].content, "+ ");
    let bad = tool_end_line("edit_file(x)", false, 20, "old_string not found", true);
    assert_eq!(bad.spans[0].content, "✗ ", "failure outranks the batch marker");
    assert_eq!(bad.spans[0].style.fg, Some(theme::ERROR));
}

#[test]
fn clip_adds_ellipsis_only_when_truncating() {
    assert_eq!(clip("short", 10), "short");
    assert_eq!(clip("truncate me", 5), "trun…");
    assert_eq!(clip("x", 0), "");
}

fn tray_app(rows: &[(&str, &str, Option<bool>)]) -> super::super::app::App {
    use super::super::app::{App, UiMsg};
    use crate::events::AgentEvent;
    let mut app = App::new("vertex", "m", ".".to_string(), "sys".to_string(), None, Vec::new(), false);
    for (i, (desc, status, done)) in rows.iter().enumerate() {
        app.on_ui(UiMsg::Agent(AgentEvent::SubagentStart {
            id: i,
            desc: desc.to_string(),        agent_type: "scout".into(),
        }));
        app.on_ui(UiMsg::Agent(AgentEvent::SubagentProgress {
            id: i,
            status: status.to_string(),
        }));
        if let Some(ok) = done {
            app.on_ui(UiMsg::Agent(AgentEvent::SubagentEnd {
                id: i,
                ok: *ok,
                summary: format!("result {i}"),
                elapsed_ms: 1500,
            }));
        }
    }
    app
}

fn tray_text(lines: &[Line<'_>]) -> Vec<String> {
    lines.iter().map(row_text).collect()
}

#[test]
fn tray_gives_the_title_full_width_before_the_status() {
    let long_title = "Port the editor tests over to the brand new tui module layout";
    let app = tray_app(&[(long_title, "bash(cargo test)", None)]);
    let now = Instant::now();

    // Plenty of width: full title AND status visible.
    let wide = tray_text(&subagent_panel(&app, now, 110));
    assert!(wide[0].contains(long_title), "full title must render: {wide:?}");
    assert!(wide[0].contains("bash(cargo test)"));

    // Tight width: the title survives untruncated; the status is what gives way.
    let narrow = tray_text(&subagent_panel(&app, now, (7 + long_title.len() + 8) as u16));
    assert!(
        narrow[0].contains(long_title),
        "title must win the width fight: {narrow:?}"
    );
    assert!(!narrow[0].contains("bash(cargo test)"));
}

#[test]
fn rail_rows_carry_the_fan_and_pin_finished_agents() {
    let app = tray_app(&[
        ("first task", "working", Some(true)),
        ("second task", "working", None),
        ("third task", "working", Some(false)),
    ]);
    let lines = subagent_panel(&app, Instant::now(), 100);
    let text = tray_text(&lines);

    // The fan: fork on the first row, closed on the last, no header row.
    assert_eq!(text.len(), 3);
    assert!(text[0].starts_with("├─┬─"), "fork: {text:?}");
    assert!(text[1].starts_with("│ ├─"), "middle: {text:?}");
    assert!(text[2].starts_with("│ ╰─"), "close: {text:?}");

    // Finished rows stay pinned with their outcome glyph and step counter.
    assert!(text[0].contains('✓') && text[0].contains("first task"));
    assert!(text[2].contains('✗') && text[2].contains("third task"));
    assert!(text[0].contains("·1"), "step counter shown: {text:?}");
    // The running row spins (some braille frame), not a check.
    assert!(!text[1].contains('✓') && !text[1].contains('✗'));

    // Height: one row per agent, no header.
    assert_eq!(subagent_panel_rows(3), 3);
    assert_eq!(subagent_panel_rows(1), 1);
    assert_eq!(subagent_panel_rows(0), 0);
}

#[test]
fn fmt_mmss_ticks_seconds() {
    assert_eq!(fmt_mmss(47), "47s");
    assert_eq!(fmt_mmss(64), "1m04");
    assert_eq!(fmt_mmss(750), "12m30");
}

#[test]
fn sanitize_expands_tabs_and_drops_control_chars() {
    assert_eq!(sanitize_display("1\t//! doc"), "1   //! doc"); // tab at col 1 → to stop 4
    assert_eq!(sanitize_display("\tx"), "    x"); // tab at col 0 → 4 spaces
    assert_eq!(sanitize_display("a\x1b[31mb\rc"), "abc"); // ESC/CSI/CR stripped
    assert_eq!(sanitize_display("plain"), "plain"); // untouched
}

#[test]
fn pushed_lines_are_sanitized_so_raw_tabs_never_reach_the_terminal() {
    // A read_file result looks like "3\t    fn main()". The raw tab would desync the terminal;
    // the transcript must store it expanded.
    let mut view = TranscriptView::new(vec![]);
    view.push(dim_line("3\tfn main()"));
    assert!(!view.plain().contains('\t'), "no raw tab survives a push");
    assert!(view.plain().contains("3   fn main()"));
}

#[test]
fn scrolled_up_badge_shows_and_paging_to_the_bottom_restores_follow() {
    use super::super::app::App;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    let mut app = App::new("vertex", "m", ".".to_string(), "sys".to_string(), None, Vec::new(), false);
    for i in 0..80 {
        app.transcript.push(dim_line(format!("line {i}")));
    }
    app.follow = false;
    app.scroll = 0;
    let mut term = Terminal::new(TestBackend::new(60, 16)).unwrap();
    app.refresh_input(60);
    term.draw(|f| draw(f, &mut app)).unwrap();
    let text = |t: &Terminal<TestBackend>| -> String {
        t.backend().buffer().content().iter().map(|c| c.symbol()).collect()
    };
    assert!(text(&term).contains("scroll down for latest"), "badge missing");
    assert!(!app.follow, "reading history must not re-pin");

    // Paging past the end clamps to the bottom, restores follow, and drops the badge.
    app.scroll = u16::MAX;
    term.draw(|f| draw(f, &mut app)).unwrap();
    assert!(app.follow, "bottom restores follow");
    assert!(!text(&term).contains("scroll down for latest"));
}

#[test]
fn rail_connectors_draw_a_closed_fan() {
    // Three agents: fork, middle, close — all the same width so titles align.
    assert_eq!(rail_connector(0, 3), "├─┬─");
    assert_eq!(rail_connector(1, 3), "│ ├─");
    assert_eq!(rail_connector(2, 3), "│ ╰─");
    // A single agent keeps the fork so the ├─╯ join line still connects.
    assert_eq!(rail_connector(0, 1), "├─┬─");
    for (i, n) in [(0, 1), (0, 3), (1, 3), (2, 3)] {
        assert_eq!(rail_connector(i, n).chars().count(), 4);
    }
}

#[test]
fn menu_modal_shows_the_session_token_breakdown() {
    use super::super::app::{App, UiMsg};
    use crate::events::AgentEvent;
    use crate::provider::TokenUsage;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    let mut app = App::new("vertex", "gpt-5", ".".to_string(), "/repo".to_string(), Some(200_000), Vec::new(), false);
    app.on_ui(UiMsg::Agent(AgentEvent::Usage(TokenUsage {
        prompt_tokens: 2500,
        completion_tokens: 100,
        total_tokens: 2600,
        cached_tokens: Some(600),
    })));
    app.on_ui(UiMsg::Agent(AgentEvent::SubagentUsage {
        id: 0,
        usage: TokenUsage {
            prompt_tokens: 500,
            completion_tokens: 15,
            total_tokens: 515,
            cached_tokens: None,
        },
    }));
    app.menu = Some(0);

    let mut term = Terminal::new(TestBackend::new(90, 24)).unwrap();
    app.refresh_input(90);
    term.draw(|f| draw(f, &mut app)).unwrap();
    let rendered: String = term
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|c| c.symbol())
        .collect();

    assert!(rendered.contains("Session tokens"), "token section missing: {rendered}");
    assert!(rendered.contains("2.5k in (600 cache) · 100 out · 1 calls"), "primary row: {rendered}");
    assert!(rendered.contains("500 in · 15 out · 1 calls"), "subagent row (no cache shown at 0): {rendered}");
    assert!(rendered.contains("3.0k in · 115 out"), "total row: {rendered}");
}

#[test]
fn frame_composes_markdown_status_meter_and_subagent_panel() {
    use super::super::app::{App, UiMsg};
    use crate::events::AgentEvent;
    use crate::provider::TokenUsage;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    let mut app = App::new("vertex", "gpt-5", ".".to_string(), "/repo".to_string(), Some(200_000), Vec::new(), false);
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
        desc: "port editor tests".to_string(),        agent_type: "scout".into(),
    }));

    let mut term = Terminal::new(TestBackend::new(80, 20)).unwrap();
    app.refresh_input(80);
    // Two frames: the tray coalesce effect starts fully dissolved on frame one; after its
    // duration elapses the rows must be fully material again.
    term.draw(|f| draw(f, &mut app)).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    term.draw(|f| draw(f, &mut app)).unwrap();
    assert!(app.tray_fx.is_none(), "coalesce effect must finish and clear");
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
        rendered.contains("agentj · vertex/gpt-5 · ."),
        "footer identity line missing"
    );
    assert!(
        rendered.contains("port editor tests"),
        "subagent panel row missing"
    );
}

#[test]
fn jobs_panel_lists_running_jobs_with_elapsed_and_timeout() {
    use crate::jobs::JobInfo;
    let mut app = App::new("vertex", "m", ".".to_string(), "/repo".to_string(), None, Vec::new(), false);
    let start = Instant::now();
    app.jobs = vec![JobInfo {
        id: 2,
        command: "gh pr checks 2805 --watch".to_string(),
        started: start,
        timeout: Some(Duration::from_secs(120)),
    }];
    let lines = jobs_panel(&app, start + Duration::from_secs(65));
    let text: String = lines
        .iter()
        .flat_map(|l| l.spans.iter().map(|s| s.content.as_ref()))
        .collect();
    assert!(text.contains("[2]"), "job id: {text}");
    assert!(text.contains("gh pr checks 2805"), "command: {text}");
    assert!(text.contains("1m05"), "elapsed: {text}");
    assert!(text.contains('⏱'), "timeout: {text}");
}

#[test]
fn screen_selection_snapshots_and_copies_any_content_incl_a_modal() {
    use super::super::app::Selection;
    use crate::mcp::client::McpStatus;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    // A failing server opens the MCP modal; selection must be able to copy its text.
    let mcp = vec![McpStatus { name: "linear".into(), outcome: crate::mcp::client::McpOutcome::Err("boom".into()) }];
    let mut app = App::new("vertex", "m", ".".to_string(), "/repo".to_string(), None, mcp, false);
    app.selection = Some(Selection { anchor: (0, 0), cursor: (89, 23) }); // whole screen
    let mut term = Terminal::new(TestBackend::new(90, 24)).unwrap();
    app.refresh_input(90);
    term.draw(|f| draw(f, &mut app)).unwrap();

    assert!(!app.screen_rows.is_empty(), "frame text snapshotted for copy");
    let copied = app.selected_screen_text(app.selection.unwrap());
    assert!(copied.contains("MCP servers"), "copy reads the modal text: {copied}");
    assert!(copied.contains("linear"));
}

#[test]
fn mcp_modal_lists_server_statuses() {
    use crate::mcp::client::McpStatus;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    let mcp = vec![
        McpStatus { name: "linear".into(), outcome: crate::mcp::client::McpOutcome::Ok(12) },
        McpStatus { name: "atlassian".into(), outcome: crate::mcp::client::McpOutcome::Err("address already in use 127.0.0.1:3736".into()) },
    ];
    let mut app = App::new("vertex", "m", ".".to_string(), "/repo".to_string(), None, mcp, false);
    assert!(app.mcp_modal_open(), "a failure opens the modal");
    let mut term = Terminal::new(TestBackend::new(90, 24)).unwrap();
    app.refresh_input(90);
    term.draw(|f| draw(f, &mut app)).unwrap();
    let rendered: String = term.backend().buffer().content().iter().map(|c| c.symbol()).collect();
    assert!(rendered.contains("MCP servers"), "title: {rendered}");
    assert!(rendered.contains("linear"));
    assert!(rendered.contains("12 tools"));
    assert!(rendered.contains("atlassian"));
    assert!(rendered.contains("address already in use"), "error shown: {rendered}");
}

#[test]
fn setup_modal_renders_the_form_over_the_transcript() {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    // needs_setup opens the wizard on launch.
    let mut app = App::new("(none)", "(none)", ".".to_string(), "/repo".to_string(), None, Vec::new(), true);
    assert!(app.setup.is_some());
    let mut term = Terminal::new(TestBackend::new(80, 24)).unwrap();
    app.refresh_input(80);
    term.draw(|f| draw(f, &mut app)).unwrap();
    let rendered: String = term
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(rendered.contains("Set up a provider"), "modal title missing: {rendered}");
    assert!(rendered.contains("Provider"), "provider field missing");
    assert!(rendered.contains("1) azure"), "provider choices missing");
    assert!(rendered.contains("Esc: cancel"), "modal hint missing");
}

#[test]
fn frame_shows_the_slash_popover_above_the_status_row() {
    use super::super::app::App;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    let mut app = App::new("vertex", "gpt-5", ".".to_string(), "/repo".to_string(), None, Vec::new(), false);
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
    // content_width 5 used directly (no second padding subtraction): "1234567890" (10 chars)
    // hard-wraps to 2 rows, "tiny" (4) to 1 → 2 + 2 + 1 = 5 rows.
    assert_eq!(wrapped_rows_for_line(&transcript[0], 5), 2);
    assert_eq!(transcript_rows(&transcript, 5), 5);
    let mut view = TranscriptView::new(transcript);
    view.ensure_width(5);
    assert_eq!(view.max_scroll(3), 2);
}

#[test]
fn window_slices_the_transcript_without_cloning_all_of_it() {
    // 20 lines, each hard-wraps to 2 rows at content width 5 ("123456" → "12345"+"6") → 40 rows.
    let lines: Vec<Line> = (0..20).map(|_| Line::from("123456")).collect();
    let mut view = TranscriptView::new(lines);
    view.ensure_width(5);
    assert_eq!(view.max_scroll(6), 34); // 40 - 6

    let (first, window, kinds, intra, _bs) = view.window(10, 6);
    assert_eq!((first, intra), (5, 0));
    assert!(window.len() <= 5, "clones only the window, not all 20: {}", window.len());
    assert_eq!(window.len(), kinds.len(), "kinds are index-aligned with the window lines");

    let (first2, _w2, _k2, intra2, _bs2) = view.window(11, 6);
    assert_eq!((first2, intra2), (5, 1));
}

fn card_app() -> super::super::app::App {
    use super::super::app::{App, UiMsg};
    use crate::events::AgentEvent;
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    let mut app = App::new("vertex", "gpt-5", ".".to_string(), "sys".to_string(), None, Vec::new(), false);
    app.editor.insert_str("Finish GEN-3320");
    app.on_input(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))); // pushes the user card
    app.on_ui(UiMsg::Agent(AgentEvent::ToolStart { name:"bash".into(), args:"git status".into(), step:0 }));
    app.on_ui(UiMsg::Agent(AgentEvent::ToolEnd { ok:true, elapsed_ms:39, summary:"clean".into() }));
    app.on_ui(UiMsg::Agent(AgentEvent::Note("context compacted — elided 3 older tool results".into())));
    app.on_ui(UiMsg::Agent(AgentEvent::Message("Design is locked; implementing now.".into())));
    app
}

#[test]
fn cards_tint_messages_leave_the_machinery_plain_and_focus_hides_it() {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    let mut app = card_app();
    let mut term = Terminal::new(TestBackend::new(64, 18)).unwrap();
    let render = |app: &mut super::super::app::App, term: &mut Terminal<TestBackend>| {
        app.refresh_input(64);
        term.draw(|f| draw(f, app)).unwrap();
    };
    render(&mut app, &mut term);
    let buf = term.backend().buffer();
    let row_str = |y: u16| -> String { (0..64).map(|x| buf.cell((x, y)).unwrap().symbol().to_string()).collect() };
    let find = |needle: &str| (0..18).find(|&y| row_str(y).contains(needle));
    // A representative cell inside the card body — past the label column (LABEL_W=8) + bar.
    let bg = |y: u16| buf.cell((16, y)).unwrap().style().bg;

    let uy = find("Finish GEN-3320").expect("user card row");
    assert!(row_str(uy).contains('▌'), "user card carries a left bar: {}", row_str(uy));
    assert_eq!(bg(uy), Some(theme::user_bg()), "user card row is tinted");

    let ay = find("Design is locked").expect("assistant card row");
    assert!(row_str(ay).contains('▌'), "assistant card carries a left bar");
    assert_eq!(bg(ay), Some(theme::assistant_bg()), "assistant card row is tinted");

    // Tool + note render plainly between the cards — no bar, no tint.
    let ty = find("bash(git status)").expect("tool row");
    assert!(!row_str(ty).contains('▌'), "tool line has no card bar");
    assert_ne!(bg(ty), Some(theme::user_bg()), "tool line is not tinted");
    assert_ne!(bg(ty), Some(theme::assistant_bg()));

    // Focus hides the machinery, keeping just the conversation cards.
    app.focus = true;
    app.transcript.set_focus(true);
    render(&mut app, &mut term);
    let buf = term.backend().buffer();
    let all: String = (0..18)
        .flat_map(|y| (0..64).map(move |x| (x, y)))
        .map(|(x, y)| buf.cell((x, y)).unwrap().symbol().to_string())
        .collect();
    assert!(!all.contains("bash(git status)"), "Focus hides tool calls");
    assert!(all.contains("Finish GEN-3320") && all.contains("Design is locked"), "conversation stays");
}

#[test]
fn model_reasoning_renders_as_a_labeled_thinking_block() {
    use super::super::app::{App, UiMsg};
    use crate::events::AgentEvent;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    let mut app = App::new("vertex", "gpt-5", ".".to_string(), "sys".to_string(), None, Vec::new(), false);
    app.on_ui(UiMsg::Agent(AgentEvent::Thinking("weighing the two approaches".into())));
    let mut term = Terminal::new(TestBackend::new(72, 12)).unwrap();
    app.refresh_input(72);
    term.draw(|f| draw(f, &mut app)).unwrap();
    let buf = term.backend().buffer();
    let rows: Vec<String> = (0..12)
        .map(|y| (0..72).map(|x| buf.cell((x, y)).unwrap().symbol().to_string()).collect())
        .collect();
    let all = rows.join("\n");
    assert!(all.contains("weighing the two approaches"), "reasoning text shown: {all}");
    assert!(
        rows.iter().any(|r| r.get(1..9).map(|s| s.trim() == "thinking").unwrap_or(false)),
        "a `thinking` label marks the block: {rows:?}"
    );
}

#[test]
fn each_transcript_block_is_labeled_once_by_type() {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    let mut app = card_app();
    let mut term = Terminal::new(TestBackend::new(72, 18)).unwrap();
    app.refresh_input(72);
    term.draw(|f| draw(f, &mut app)).unwrap();
    let buf = term.backend().buffer();
    // The type label sits in the left column: PAD_X(1) then LABEL_W(8) → screen cols 1..9.
    let labels: Vec<String> = (0..18)
        .map(|y| {
            (1..9).map(|x| buf.cell((x, y)).unwrap().symbol().to_string()).collect::<String>().trim().to_string()
        })
        .filter(|s| !s.is_empty())
        .collect();
    for kind in ["you", "agentj", "tool", "note"] {
        assert!(labels.iter().any(|l| l == kind), "expected a `{kind}` label, got {labels:?}");
    }
    // A block is labeled exactly once — not on every wrapped/padded row of the card.
    assert_eq!(labels.iter().filter(|l| *l == "you").count(), 1, "{labels:?}");
    assert_eq!(labels.iter().filter(|l| *l == "agentj").count(), 1, "{labels:?}");
}
