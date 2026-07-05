use super::tray::strip_tok_suffix;
use super::{App, AppEffect, Selection, SetupStep, TranscriptGeom, TurnHandle, UiMsg};
use crate::commands::SLASH_COMMANDS;
use crate::events::AgentEvent;
use crate::model::Provider;
use crate::provider::{ChatMessage, TokenUsage};
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};

fn app() -> App {
    App::new("vertex", "dummy", ".".to_string(), "sys".to_string(), None, Vec::new(), false)
}

fn mouse(kind: MouseEventKind) -> Event {
    Event::Mouse(MouseEvent {
        kind,
        column: 0,
        row: 0,
        modifiers: KeyModifiers::NONE,
    })
}

#[test]
fn selected_screen_text_reads_the_rendered_rows_across_lines() {
    let mut a = app();
    // Simulate a rendered frame (what's on screen), including trailing padding to trim.
    a.screen_rows = vec![
        "  hello world      ".to_string(),
        "  second line      ".to_string(),
    ];
    // Drag from (4,0) to (8,1): row 0 from col 4 to end, row 1 from col 0 to col 8 (linear
    // selection, so the last row includes its leading indent).
    let sel = Selection { anchor: (4, 0), cursor: (8, 1) };
    assert_eq!(a.selected_screen_text(sel), "llo world\n  second");
    // reversed drag → same range
    let rev = Selection { anchor: (8, 1), cursor: (4, 0) };
    assert_eq!(a.selected_screen_text(rev), "llo world\n  second");
    // single row selection past the text trims trailing spaces
    let one = Selection { anchor: (2, 0), cursor: (19, 0) };
    assert_eq!(a.selected_screen_text(one), "hello world");
}

#[test]
fn autoscroll_selection_scrolls_and_keeps_the_anchor_on_its_text() {
    let mut a = app();
    a.tgeom = Some(TranscriptGeom { y: 0, viewport: 10 }); // transcript rows 0..=9
    a.scroll = 5;
    a.selection = Some(Selection { anchor: (3, 4), cursor: (3, 9) });
    // drag to the bottom edge (row 9) → scroll down one, anchor shifts up to track its text
    a.autoscroll_selection(9);
    assert_eq!(a.scroll, 6);
    assert!(!a.follow);
    assert_eq!(a.selection.unwrap().anchor, (3, 3));
    // dragging in the middle does nothing
    a.autoscroll_selection(5);
    assert_eq!(a.scroll, 6);
}

#[test]
fn strip_tok_suffix_removes_only_a_real_spend_suffix() {
    assert_eq!(strip_tok_suffix("mapped it · 1234 tok"), "mapped it");
    assert_eq!(strip_tok_suffix("no suffix here"), "no suffix here");
    assert_eq!(strip_tok_suffix("ends in tok"), "ends in tok"); // no " · N" shape
    assert_eq!(strip_tok_suffix("uses · abc tok"), "uses · abc tok"); // not digits
}

#[test]
fn session_tokens_accumulate_primary_and_subagent_spend_separately() {
    let mut a = app();
    let u = |p: u64, c: u64, cached: Option<u64>| TokenUsage {
        prompt_tokens: p,
        completion_tokens: c,
        total_tokens: p + c,
        cached_tokens: cached,
    };
    // Two primary calls: totals sum, the ctx meter keeps only the latest.
    a.on_agent(AgentEvent::Usage(u(1000, 40, Some(600))));
    a.on_agent(AgentEvent::Usage(u(1500, 60, None)));
    // Two subagent calls, from different subagents in one batch.
    a.on_agent(AgentEvent::SubagentUsage { id: 0, usage: u(300, 10, Some(100)) });
    a.on_agent(AgentEvent::SubagentUsage { id: 1, usage: u(200, 5, None) });

    let t = a.tokens;
    assert_eq!((t.primary_in, t.primary_out, t.primary_cached, t.primary_calls), (2500, 100, 600, 2));
    assert_eq!((t.sub_in, t.sub_out, t.sub_cached, t.sub_calls), (500, 15, 100, 2));
    assert_eq!((t.total_in(), t.total_out()), (3000, 115));
    // subagent usage never touches the context-fill meter
    assert_eq!(a.last_usage.unwrap().prompt_tokens, 1500);
}

#[test]
fn steering_toggle_collapses_and_restores_supervisor_notes_retroactively() {
    let enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
    let mut a = app();
    a.on_agent(AgentEvent::Note("[supervisor: SPEAR checkpoint — converge]".into()));
    a.on_agent(AgentEvent::Note("[job 2 `pnpm test` finished, exit 0]".into()));
    assert!(a.transcript.plain().contains("SPEAR checkpoint"), "visible by default");

    // Menu item 0 toggles steering OFF: already-pushed rows collapse immediately.
    a.menu = Some(0);
    a.on_key(enter);
    assert!(!a.show_steering);
    assert!(!a.transcript.plain().contains("SPEAR checkpoint"), "collapsed retroactively");
    assert!(a.transcript.plain().contains("finished, exit 0"), "job notes stay visible");
    // New steering notes stay hidden while off…
    a.on_agent(AgentEvent::Note("[supervisor: ASSESS check]".into()));
    assert!(!a.transcript.plain().contains("ASSESS check"));
    // …and everything reappears, in order, when toggled back on.
    a.on_key(enter); // menu stayed open on item 0
    let t = a.transcript.plain();
    assert!(t.contains("SPEAR checkpoint") && t.contains("ASSESS check"), "{t}");
}

#[test]
fn auto_scroll_toggle_repins_on_new_activity() {
    let enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
    let mut a = app();
    a.follow = false;
    a.on_agent(AgentEvent::Message("hello".into()));
    assert!(!a.follow, "default OFF: a scrolled-up reader stays put");

    a.menu = Some(1); // menu item 1: auto-scroll
    a.on_key(enter);
    assert!(a.auto_follow);
    a.follow = false;
    a.on_agent(AgentEvent::Message("world".into()));
    assert!(a.follow, "auto-scroll re-pins on new content");
}

#[test]
fn step_gate_offers_empty_enter_continue() {
    let mut a = app();
    a.on_agent(AgentEvent::StepLimit(40));
    assert!(a.step_limit_hit);
    assert!(a.transcript.plain().contains("step gate"), "{}", a.transcript.plain());
    // Empty Enter continues the turn with an explicit continue message.
    let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(matches!(effect, AppEffect::SpawnTurn));
    assert!(!a.step_limit_hit);
    assert!(a.running);
    assert!(a
        .messages
        .iter()
        .any(|m| m.content.as_deref().is_some_and(|c| c.contains("pick up exactly where you left off"))));
    // With no gate pending, an empty Enter is still a no-op.
    a.running = false;
    let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(matches!(effect, AppEffect::None));
}

#[test]
fn ctrl_p_toggles_the_menu_and_enter_toggles_steering() {
    let mut a = app();
    let ctrl_p = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL);
    a.on_key(ctrl_p);
    assert_eq!(a.menu, Some(0));
    // Enter on item 0 flips steering and keeps the menu open.
    assert!(a.show_steering);
    a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(!a.show_steering);
    assert_eq!(a.menu, Some(0), "menu stays open after a toggle");
    // Esc closes; Ctrl-P reopens even while running.
    a.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(a.menu.is_none());
    a.running = true;
    a.on_key(ctrl_p);
    assert!(a.menu.is_some(), "menu opens while a turn runs");
}

#[test]
fn mouse_wheel_scrolls_transcript() {
    let mut a = app();
    a.scroll = 5;
    a.follow = true;

    a.on_input(mouse(MouseEventKind::ScrollUp));
    assert_eq!(a.scroll, 2);
    assert!(!a.follow);

    let before = a.follow;
    a.on_input(mouse(MouseEventKind::ScrollDown));
    assert_eq!(a.scroll, 5);
    assert_eq!(a.follow, before);
    // a non-scroll mouse event is a no-op
    a.on_input(mouse(MouseEventKind::Down(MouseButton::Left)));
    assert_eq!(a.scroll, 5);
}

#[test]
fn setup_wizard_collects_details_then_emits_configure() {
    let mut a = app();
    a.start_setup();
    assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::Provider);
    // a bad provider choice stays put
    assert!(matches!(a.advance_setup("nonsense"), AppEffect::None));
    assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::Provider);
    // walk the happy path
    assert!(matches!(a.advance_setup("2"), AppEffect::None));
    assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::BaseUrl);
    assert!(matches!(a.advance_setup("http://localhost:8080/v1"), AppEffect::None));
    assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::ApiKey);
    assert!(matches!(a.advance_setup("sk-123"), AppEffect::None));
    assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::Model);
    match a.advance_setup("gpt-4.1") {
        AppEffect::ConfigureProvider(s) => {
            assert_eq!(s.provider, Provider::Custom);
            assert_eq!(s.base_url, "http://localhost:8080/v1");
            assert_eq!(s.api_key, "sk-123");
            assert_eq!(s.model, "gpt-4.1");
        }
        _ => panic!("last step should emit ConfigureProvider"),
    }
}

#[test]
fn wizard_submit_is_not_treated_as_a_turn_or_command() {
    let mut a = app();
    a.start_setup();
    a.editor.insert_str("azure");
    let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(matches!(effect, AppEffect::None), "wizard input never spawns a turn");
    assert!(!a.running);
    assert_eq!(a.setup.as_ref().unwrap().step, SetupStep::BaseUrl);
}

#[test]
fn bare_task_reference_synthesizes_a_directive_so_work_starts() {
    let mut a = app();
    std::env::set_var("AGENTJ_ALLOW_PRIMARY", "1"); // bypass the worktree guard in the test
    let effect = a.submit_task("/task GEN-3300");
    std::env::remove_var("AGENTJ_ALLOW_PRIMARY");
    match effect {
        AppEffect::Rekey { reference, desc } => {
            assert_eq!(reference, "GEN-3300");
            assert!(!desc.is_empty(), "a bare /task must still produce a task directive");
            assert!(desc.contains("GEN-3300"), "directive references the task");
        }
        _ => panic!("expected a Rekey effect that carries a directive"),
    }
    // An explicit description is passed through unchanged.
    let effect = {
        std::env::set_var("AGENTJ_ALLOW_PRIMARY", "1");
        let e = a.submit_task("/task GEN-3300 fix the login bug");
        std::env::remove_var("AGENTJ_ALLOW_PRIMARY");
        e
    };
    match effect {
        AppEffect::Rekey { desc, .. } => assert_eq!(desc, "fix the login bug"),
        _ => panic!("expected Rekey"),
    }
}

#[test]
fn submit_plain_text_starts_a_turn() {
    let mut a = app();
    a.editor.insert_str("hello");
    let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(matches!(effect, AppEffect::SpawnTurn));
    assert!(a.running);
    assert!(a.editor.text().is_empty());
    // the user message is committed to history up front (spawn_turn clones it)
    assert!(a
        .messages
        .iter()
        .any(|m| m.role == "user" && m.content.as_deref() == Some("hello")));
}

#[tokio::test]
async fn abort_defers_interrupt_marker_behind_queued_deltas() {
    let mut a = app();
    let abort = tokio::spawn(std::future::pending::<()>()).abort_handle();
    a.turn = Some(TurnHandle {
        abort,
        job_watermark: 7,
    });
    a.running = true;
    let effect = a.abort_turn();
    assert!(matches!(effect, AppEffect::KillJobsAfter(7)));
    assert!(!a.running);
    // The note is NOT pushed at abort time — deltas the aborted turn already queued land first.
    assert!(!a.messages.iter().any(|m| m
        .content
        .as_deref()
        .is_some_and(|c| c.contains("interrupted by the user"))));

    // A late history delta from the aborted turn arrives, then the user sends the next message.
    a.on_ui(UiMsg::HistoryDelta(vec![ChatMessage::user("late delta")]));
    a.editor.insert_str("next");
    a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let idx = |needle: &str| {
        a.messages
            .iter()
            .position(|m| m.content.as_deref().is_some_and(|c| c.contains(needle)))
            .unwrap_or_else(|| panic!("missing {needle}"))
    };
    // History order: late delta, then the interrupt note, then the new user message.
    assert!(idx("late delta") < idx("interrupted by the user"));
    assert!(idx("interrupted by the user") < idx("next"));
}

fn type_str(a: &mut App, s: &str) {
    for c in s.chars() {
        a.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
    }
}

#[test]
fn slash_popover_opens_filters_and_accepts() {
    let mut a = app();
    type_str(&mut a, "/");
    let p = a.popover.as_ref().expect("popover opens on /");
    assert_eq!(p.items.len(), SLASH_COMMANDS.len());

    // fuzzy-filters as you type
    type_str(&mut a, "ta");
    let p = a.popover.as_ref().unwrap();
    assert_eq!(p.items[0].name, "/task");

    // Enter accepts the selection instead of submitting
    let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(matches!(effect, AppEffect::None));
    assert_eq!(a.editor.text(), "/task ");
    assert!(!a.running);
    assert!(a.popover.is_none());
}

#[test]
fn accepting_a_no_arg_command_lets_the_next_enter_submit() {
    let mut a = app();
    type_str(&mut a, "/ex");
    // First Enter accepts the completion…
    assert!(matches!(
        a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        AppEffect::None
    ));
    assert_eq!(a.editor.text(), "/exit");
    assert!(a.popover.is_none(), "popover must stay closed after accept");
    // …the second Enter submits (here: /exit quits).
    assert!(matches!(
        a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        AppEffect::Quit
    ));
}

#[test]
fn slash_popover_works_mid_input_but_not_mid_word() {
    let mut a = app();
    type_str(&mut a, "see ");
    type_str(&mut a, "/ex");
    assert!(a.popover.is_some(), "slash after whitespace opens the popover");
    let effect = a.on_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    assert!(matches!(effect, AppEffect::None));
    assert_eq!(a.editor.text(), "see /exit");

    let mut b = app();
    type_str(&mut b, "a/b");
    assert!(b.popover.is_none(), "slash glued to a word must not open the popover");
}

#[test]
fn slash_popover_arrows_select_and_esc_dismisses_until_token_changes() {
    let mut a = app();
    type_str(&mut a, "/");
    a.on_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(a.popover.as_ref().unwrap().selected, 1);
    a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(a.popover.as_ref().unwrap().selected, 0);
    a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)); // wraps
    assert_eq!(a.popover.as_ref().unwrap().selected, SLASH_COMMANDS.len() - 1);

    // Esc closes it and keeps it closed for the same token…
    a.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(a.popover.is_none());
    assert!(!a.editor.text().is_empty(), "Esc dismisses the popover, not the input");
    // …but typing more reopens it.
    type_str(&mut a, "t");
    assert!(a.popover.is_some());
}

#[test]
fn plain_up_down_scrolls_single_line_but_moves_cursor_in_multiline() {
    let mut a = app();
    type_str(&mut a, "hello");
    a.scroll = 5;
    a.follow = true;
    a.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(a.scroll, 4, "single-line input: ↑ scrolls the transcript");
    assert!(!a.follow);

    let mut b = app();
    type_str(&mut b, "one");
    b.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));
    type_str(&mut b, "two");
    let before = b.scroll;
    b.on_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    assert_eq!(b.scroll, before, "multi-line input: ↑ moves the cursor, not the scroll");
    assert!(b.editor.cursor() < b.editor.text().len());
}

fn transcript_text(a: &App) -> String {
    a.transcript.plain()
}

#[test]
fn tray_collapses_into_transcript_summaries_when_the_delegate_batch_lands() {
    use crate::events::AgentEvent;
    let mut a = app();
    a.on_ui(UiMsg::Agent(AgentEvent::ToolStart {
        name: "delegate".to_string(),
        args: "{tasks:…}".to_string(),
        step: 0,
    }));
    a.on_ui(UiMsg::Agent(AgentEvent::SubagentStart {
        id: 0,
        desc: "port the tests".to_string(),
    }));
    a.on_ui(UiMsg::Agent(AgentEvent::SubagentProgress {
        id: 0,
        status: "bash(cargo test)".to_string(),
    }));
    assert_eq!(a.subagents[&0].steps, 1);

    a.on_ui(UiMsg::Agent(AgentEvent::SubagentUsage {
        id: 0,
        usage: TokenUsage {
            prompt_tokens: 1234,
            completion_tokens: 50,
            total_tokens: 1284,
            cached_tokens: None,
        },
    }));
    a.on_ui(UiMsg::Agent(AgentEvent::SubagentEnd {
        id: 0,
        ok: true,
        summary: "all 4 tests pass · 1234 tok".to_string(),
        elapsed_ms: 2000,
    }));
    // Finished but wave still open: row pinned in the rail, no transcript block yet. The
    // summary's " · N tok" suffix is stripped — the row meters its own tokens.
    assert_eq!(a.subagents[&0].done, Some(true));
    assert_eq!(a.subagents[&0].status, "all 4 tests pass");
    assert_eq!(a.subagents[&0].tokens_in, 1234);
    assert!(!transcript_text(&a).contains("all 4 tests pass"));

    a.on_ui(UiMsg::Agent(AgentEvent::ToolEnd {
        ok: true,
        elapsed_ms: 2100,
        summary: "[subagent 0] …".to_string(),
    }));
    // Wave joined: rail empty, the frozen fork/join block is permanent transcript history.
    assert!(a.subagents.is_empty());
    let t = transcript_text(&a);
    assert!(t.contains("├─┬─ ✓ port the tests"), "frozen rail row: {t}");
    assert!(t.contains("all 4 tests pass"));
    assert!(t.contains("· 1.2k tok"), "per-agent spend on the frozen row: {t}");
    assert!(t.contains("├─╯  wave 1 · 1/1 ok"), "join line: {t}");
}

#[test]
fn init_and_knowledge_commands_dispatch_their_effects() {
    let mut a = app();
    a.editor.insert_str("/init");
    assert!(matches!(
        a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        AppEffect::Init
    ));
    assert!(!a.running, "the turn starts only once the loop builds the directive");

    let mut b = app();
    b.editor.insert_str("/knowledge");
    assert!(matches!(
        b.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        AppEffect::Knowledge
    ));
}

#[test]
fn command_turns_snapshot_on_clean_completion_only() {
    use crate::events::AgentEvent;

    // Clean run → TurnDone yields a Snapshot effect exactly once.
    let mut a = app();
    a.start_command_turn("directive".to_string(), "mapping");
    assert!(a.running && a.pending_snapshot);
    assert!(matches!(a.on_ui(UiMsg::TurnDone), AppEffect::Snapshot));
    assert!(!a.pending_snapshot);
    assert!(matches!(a.on_ui(UiMsg::TurnDone), AppEffect::None));

    // A turn that errored skips the snapshot.
    let mut b = app();
    b.start_command_turn("directive".to_string(), "mapping");
    b.on_ui(UiMsg::Agent(AgentEvent::Error("boom".to_string())));
    assert!(matches!(b.on_ui(UiMsg::TurnDone), AppEffect::None));

    // An aborted turn drops the pending snapshot.
    let mut c = app();
    c.start_command_turn("directive".to_string(), "mapping");
    c.abort_turn();
    assert!(!c.pending_snapshot);
    assert!(matches!(c.on_ui(UiMsg::TurnDone), AppEffect::None));

    // Ordinary turns never snapshot.
    let mut d = app();
    d.editor.insert_str("hello");
    d.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(matches!(d.on_ui(UiMsg::TurnDone), AppEffect::None));
}

#[test]
fn exit_command_quits() {
    let mut a = app();
    a.editor.insert_str("/exit");
    let effect = a.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(matches!(effect, AppEffect::Quit));
}

#[test]
fn double_ctrl_c_quits_within_window() {
    let mut a = app();
    assert!(matches!(
        a.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        AppEffect::None
    ));
    assert!(matches!(
        a.on_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        AppEffect::Quit
    ));
}
