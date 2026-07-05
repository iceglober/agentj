use super::compact::{compact_history, estimate_prompt_tokens};
use super::delegate::{cap_result, task_label};
use super::supervisor::is_check_command;
use super::{run_turn, Session};
use crate::config::Config;
use crate::events::AgentEvent;
use crate::jobs::JobManager;
use crate::provider::{
    AssistantTurn, ChatMessage, FunctionCall, Llm, ScriptStep, TokenUsage, ToolCall,
};
use crate::tools::{tool_specs, Tools};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::unbounded_channel;

#[test]
fn delegate_spec_gated_by_allow_delegate() {
    let with = tool_specs(true);
    let without = tool_specs(false);
    assert!(with.iter().any(|s| s.name == "delegate"));
    assert!(!without.iter().any(|s| s.name == "delegate"));
    // job tools are present in both.
    assert!(without.iter().any(|s| s.name == "job_start"));
}

fn test_cfg() -> Config {
    Config {
        max_steps: 40,
        max_idle_nudges: 6,
        idle_wait: Duration::from_secs(120),
        max_parallel_subagents: 4,
        context_window: None,
        compact_threshold: 12_000,
        check: None,
    }
}

fn session(steps: Vec<ScriptStep>) -> Session {
    session_cfg(steps, test_cfg())
}

fn session_cfg(steps: Vec<ScriptStep>, cfg: Config) -> Session {
    let jobs = JobManager::new(".".to_string());
    let tools = Tools::new(PathBuf::from("."), jobs, None);
    Session {
        llm: Arc::new(Llm::Script(std::sync::Mutex::new(VecDeque::from(steps)))),
        tools: Arc::new(tools),
        cfg: Arc::new(cfg),
    }
}

fn turn_text(s: &str) -> AssistantTurn {
    AssistantTurn {
        content: Some(s.to_string()),
        tool_calls: vec![],
        finish_reason: "stop".into(),
        usage: None,
    }
}

fn turn_delegate(tasks: &[&str]) -> AssistantTurn {
    let items: Vec<_> = tasks.iter().map(|t| serde_json::json!({ "task": t })).collect();
    let args = serde_json::json!({ "tasks": items }).to_string();
    AssistantTurn {
        content: None,
        tool_calls: vec![ToolCall {
            id: "call_1".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: "delegate".into(),
                arguments: args,
            },
        }],
        finish_reason: "tool_calls".into(),
        usage: None,
    }
}

fn turn_tool(name: &str, args: serde_json::Value) -> AssistantTurn {
    AssistantTurn {
        content: None,
        tool_calls: vec![ToolCall {
            id: "call_x".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: args.to_string(),
            },
        }],
        finish_reason: "tool_calls".into(),
        usage: None,
    }
}

async fn run_and_collect(sess: &Session) -> Vec<AgentEvent> {
    let (tx, mut rx) = unbounded_channel::<AgentEvent>();
    let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("go")];
    let _ = run_turn(sess, &mut msgs, &tx, true, None).await;
    drop(tx);
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e);
    }
    events
}

/// Run a turn collecting both events and the committed history deltas.
async fn run_with_commit(sess: &Session) -> (Vec<AgentEvent>, Vec<Vec<ChatMessage>>) {
    let (tx, mut rx) = unbounded_channel::<AgentEvent>();
    let (ctx, mut crx) = unbounded_channel::<Vec<ChatMessage>>();
    let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("go")];
    let _ = run_turn(sess, &mut msgs, &tx, true, Some(&ctx)).await;
    drop(tx);
    drop(ctx);
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e);
    }
    let mut deltas = Vec::new();
    while let Some(d) = crx.recv().await {
        deltas.push(d);
    }
    (events, deltas)
}

#[tokio::test]
async fn delegate_emits_structured_lifecycle_events() {
    let sess = session(vec![
        ScriptStep::Turn(turn_delegate(&["investigate the parser"])),
        ScriptStep::Turn(turn_text("subagent done: the parser is fine")),
        ScriptStep::Turn(turn_text("all wrapped up")),
    ]);
    let events = run_and_collect(&sess).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::SubagentStart { id: 0, .. })),
        "expected a SubagentStart, got: {events:?}"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::SubagentEnd { id: 0, ok: true, .. })));
    // the delegate call itself reports success
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::ToolEnd { ok: true, .. })));
    // the flattened `↳[i]` Note lines are gone
    assert!(!events
        .iter()
        .any(|e| matches!(e, AgentEvent::Note(t) if t.contains("↳"))));
}

#[tokio::test]
async fn subagent_token_spend_rides_the_end_summary() {
    // Subagent's model call reports usage → SubagentEnd summary carries "· N tok" (what the tray
    // and the eval budget grader read), the FULL usage (in/out/cached) is forwarded as a
    // SubagentUsage event, and NO top-level Usage event leaks from the subagent.
    let mut sub_turn = turn_text("mapped it");
    sub_turn.usage = Some(TokenUsage {
        prompt_tokens: 1234,
        completion_tokens: 50,
        total_tokens: 1284,
        cached_tokens: Some(200),
    });
    let sess = session(vec![
        ScriptStep::Turn(turn_delegate(&["map the crate"])),
        ScriptStep::Turn(sub_turn),
        ScriptStep::Turn(turn_text("done")),
    ]);
    let events = run_and_collect(&sess).await;
    assert!(events.iter().any(
        |e| matches!(e, AgentEvent::SubagentEnd { summary, .. } if summary.contains("1234 tok"))
    ));
    assert!(
        events.iter().any(|e| matches!(
            e,
            AgentEvent::SubagentUsage { id: 0, usage }
                if usage.prompt_tokens == 1234
                    && usage.completion_tokens == 50
                    && usage.cached_tokens == Some(200)
        )),
        "full subagent usage must be forwarded: {events:?}"
    );
    assert!(
        !events.iter().any(|e| matches!(e, AgentEvent::Usage(_))),
        "subagent usage must never surface as a top-level Usage: {events:?}"
    );
}

#[tokio::test]
async fn panicked_subagent_surfaces_as_failed_end() {
    let sess = session(vec![
        ScriptStep::Turn(turn_delegate(&["trigger a crash"])),
        ScriptStep::Panic, // the subagent's model call panics
        ScriptStep::Turn(turn_text("recovered and carried on")),
    ]);
    let events = run_and_collect(&sess).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::SubagentEnd { ok: false, .. })),
        "a panicked subagent should still report a failed end, got: {events:?}"
    );
    // and the delegate tool call reports failure rather than silently succeeding
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::ToolEnd { ok: false, .. })));
}

#[tokio::test]
async fn commit_deltas_preserve_toolcall_reply_pairing() {
    let sess = session(vec![
        ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "Cargo.toml" }))),
        ScriptStep::Turn(turn_text("done reading")),
    ]);
    let (_events, deltas) = run_with_commit(&sess).await;

    // The assistant message carrying tool_calls and its tool reply land in the SAME delta.
    let paired = deltas.iter().any(|d| {
        d.iter().any(|m| m.role == "assistant" && !m.tool_calls.is_empty())
            && d.iter().any(|m| m.role == "tool")
    });
    assert!(
        paired,
        "assistant tool_calls and its tool reply must commit together: {deltas:?}"
    );
    // The final bare assistant reply commits on its own.
    assert!(deltas
        .iter()
        .any(|d| d.len() == 1 && d[0].role == "assistant" && d[0].tool_calls.is_empty()));
}

#[test]
fn task_label_prefers_title_then_first_sentence() {
    assert_eq!(task_label("whatever", Some("Map the crate")), "Map the crate");
    assert_eq!(
        task_label(
            "Map the Rust product in agentj-rs/. Return a tight factual summary with paths.",
            None
        ),
        "Map the Rust product in agentj-rs/."
    );
    // whitespace-only title falls back
    assert_eq!(task_label("Do the thing. And more.", Some("  ")), "Do the thing.");
    // no sentence boundary → capped
    let long = "x".repeat(150);
    assert_eq!(task_label(&long, None).chars().count(), 100);
}

#[tokio::test]
async fn delegate_title_becomes_the_tray_label() {
    let args = serde_json::json!({
        "tasks": [{ "task": "Map the Rust product. Return a summary.", "title": "Map the Rust crate" }]
    })
    .to_string();
    let sess = session(vec![
        ScriptStep::Turn(AssistantTurn {
            content: None,
            tool_calls: vec![ToolCall {
                id: "c1".into(),
                kind: "function".into(),
                function: FunctionCall {
                    name: "delegate".into(),
                    arguments: args,
                },
            }],
            finish_reason: "tool_calls".into(),
            usage: None,
        }),
        ScriptStep::Turn(turn_text("sub result")),
        ScriptStep::Turn(turn_text("done")),
    ]);
    let events = run_and_collect(&sess).await;
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::SubagentStart { desc, .. } if desc == "Map the Rust crate")));
}

fn session_in(root: &str, steps: Vec<ScriptStep>, check: Option<&str>) -> Session {
    let jobs = JobManager::new(root.to_string());
    let tools = Tools::new(PathBuf::from(root), jobs, None);
    let mut cfg = test_cfg();
    cfg.check = check.map(String::from);
    Session {
        llm: Arc::new(Llm::Script(std::sync::Mutex::new(VecDeque::from(steps)))),
        tools: Arc::new(tools),
        cfg: Arc::new(cfg),
    }
}

fn temp_root(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agentj-agent-test-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn notes_containing(events: &[AgentEvent], needle: &str) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Note(t) if t.contains(needle)))
        .count()
}

#[tokio::test]
async fn assess_gate_nudges_unverified_edits_once_then_lets_go() {
    let dir = temp_root("assess");
    let sess = session_in(
        dir.to_str().unwrap(),
        vec![
            ScriptStep::Turn(turn_tool("write_file", serde_json::json!({ "path": "a.txt", "content": "x" }))),
            ScriptStep::Turn(turn_text("all done")), // tries to finish without checking → nudged
            ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": "echo CHECK OK" }))),
            ScriptStep::Turn(turn_text("done, checks pass")),
        ],
        Some("echo CHECK"),
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "ASSESS check"), 1, "{events:?}");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Done)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn assess_gate_stays_quiet_when_the_agent_already_verified() {
    let dir = temp_root("assess-ok");
    let sess = session_in(
        dir.to_str().unwrap(),
        vec![
            ScriptStep::Turn(turn_tool("write_file", serde_json::json!({ "path": "a.txt", "content": "x" }))),
            ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": "echo CHECK OK" }))),
            ScriptStep::Turn(turn_text("done, verified")),
        ],
        Some("echo CHECK"),
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "ASSESS check"), 0, "{events:?}");
    // read-only turns are never nudged either
    let dir2 = temp_root("assess-ro");
    std::fs::write(dir2.join("r.txt"), "hi").unwrap();
    let sess = session_in(
        dir2.to_str().unwrap(),
        vec![
            ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "r.txt" }))),
            ScriptStep::Turn(turn_text("answer")),
        ],
        None,
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "ASSESS check"), 0);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

#[tokio::test]
async fn resolve_gate_flags_a_partial_commit() {
    let dir = temp_root("resolve");
    let root = dir.to_str().unwrap().to_string();
    crate::exec::run(&["git", "init", "-q"], &root, None).await.unwrap();
    std::fs::write(dir.join("a.txt"), "committed half").unwrap();
    std::fs::write(dir.join("b.txt"), "forgotten half").unwrap();
    const GIT_C: &str = "git -c user.email=t@t -c user.name=t";
    let sess = session_in(
        &root,
        vec![
            ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": format!("git add a.txt && {GIT_C} commit -qm half") }))),
            ScriptStep::Turn(turn_text("shipped!")), // tree still dirty (b.txt) → nudged
            ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": format!("git add -A && {GIT_C} commit -qm rest") }))),
            ScriptStep::Turn(turn_text("now fully shipped")),
        ],
        None,
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "RESOLVE check"), 1, "{events:?}");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Done)));
    // a clean full commit is not nudged
    let dir2 = temp_root("resolve-ok");
    let root2 = dir2.to_str().unwrap().to_string();
    crate::exec::run(&["git", "init", "-q"], &root2, None).await.unwrap();
    std::fs::write(dir2.join("a.txt"), "everything").unwrap();
    let sess = session_in(
        &root2,
        vec![
            ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": format!("git add -A && {GIT_C} commit -qm all") }))),
            ScriptStep::Turn(turn_text("shipped")),
        ],
        None,
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "RESOLVE check"), 0, "{events:?}");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

#[tokio::test]
async fn a_surviving_frontier_is_injected_on_the_first_turn_only() {
    // A frontier file from a prior session → the supervisor embeds it before the first model
    // call, so the model resumes the plan instead of re-scoping.
    let dir = temp_root("frontier");
    std::fs::create_dir_all(dir.join(".aj/task")).unwrap();
    std::fs::write(dir.join(".aj/task/plan.md"), "## pending\n- port the parser").unwrap();
    let sess = session_in(
        dir.to_str().unwrap(),
        vec![ScriptStep::Turn(turn_text("resuming"))],
        None,
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "task frontier"), 1, "{events:?}");

    // No frontier on disk → no injection.
    let dir2 = temp_root("frontier-none");
    let sess = session_in(dir2.to_str().unwrap(), vec![ScriptStep::Turn(turn_text("hi"))], None);
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "task frontier"), 0, "{events:?}");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

#[tokio::test]
async fn ship_gate_flags_edits_that_were_never_committed() {
    const GIT_C: &str = "git -c user.email=t@t -c user.name=t";
    // Edits landed, checks passed, nothing committed → one ship nudge before the turn ends.
    let dir = temp_root("ship");
    let root = dir.to_str().unwrap().to_string();
    crate::exec::run(&["git", "init", "-q"], &root, None).await.unwrap();
    let sess = session_in(
        &root,
        vec![
            ScriptStep::Turn(turn_tool("write_file", serde_json::json!({ "path": "a.txt", "content": "x" }))),
            ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": "echo CHECK OK" }))),
            ScriptStep::Turn(turn_text("all done")), // ASSESS is clear; SHIP is not → nudged
            ScriptStep::Turn(turn_text("left unshipped: user is iterating")),
        ],
        Some("echo CHECK"),
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "RESOLVE ship check"), 1, "{events:?}");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Done)));

    // A committed change is never ship-nudged.
    let dir2 = temp_root("ship-ok");
    let root2 = dir2.to_str().unwrap().to_string();
    crate::exec::run(&["git", "init", "-q"], &root2, None).await.unwrap();
    let sess = session_in(
        &root2,
        vec![
            ScriptStep::Turn(turn_tool("write_file", serde_json::json!({ "path": "a.txt", "content": "x" }))),
            ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": "echo CHECK OK" }))),
            ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": format!("git add a.txt && {GIT_C} commit -qm ship") }))),
            ScriptStep::Turn(turn_text("shipped")),
        ],
        Some("echo CHECK"),
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "RESOLVE ship check"), 0, "{events:?}");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

fn tool_msg(body: &str, id: usize) -> ChatMessage {
    ChatMessage {
        role: "tool".into(),
        content: Some(body.to_string()),
        tool_calls: vec![],
        tool_call_id: Some(format!("c{id}")),
    }
}

#[test]
fn compaction_elides_old_tool_bodies_and_is_idempotent() {
    let big = "x".repeat(300);
    let mut msgs = vec![ChatMessage::system("sys"), ChatMessage::user("go")];
    for i in 0..12 {
        msgs.push(tool_msg(&big, i));
    }
    let n = msgs.len();
    assert_eq!(compact_history(&mut msgs, 8, n), 4);
    assert!(msgs[2].content.as_deref().unwrap().starts_with("[elided"));
    assert!(!msgs[6].content.as_deref().unwrap().starts_with("[elided"), "recent kept");
    assert_eq!(compact_history(&mut msgs, 8, n), 0, "idempotent");
    // small results and non-tool roles are untouched
    assert_eq!(msgs[0].content.as_deref(), Some("sys"));
}

fn turn_tool_usage(name: &str, args: serde_json::Value, prompt_tokens: u64) -> AssistantTurn {
    let mut t = turn_tool(name, args);
    t.usage = Some(TokenUsage {
        prompt_tokens,
        completion_tokens: 0,
        total_tokens: prompt_tokens,
        cached_tokens: None,
    });
    t
}

/// 11 big (>200-char) read-only tool results with reported prompt_tokens already past the 12k
/// threshold — the runaway shape, but no edits.
fn exploration_steps() -> Vec<ScriptStep> {
    let big_cmd = serde_json::json!({ "command": "printf 'X%.0s' $(seq 500)" });
    let mut steps: Vec<ScriptStep> = (0..11)
        .map(|_| ScriptStep::Turn(turn_tool_usage("bash", big_cmd.clone(), 20_000)))
        .collect();
    steps.push(ScriptStep::Turn(turn_text("done")));
    steps
}

fn note_seen(events: &[AgentEvent], needle: &str) -> bool {
    events.iter().any(|e| matches!(e, AgentEvent::Note(t) if t.contains(needle)))
}

#[tokio::test]
async fn step_budget_nudges_convergence_and_the_gate_fires_at_the_cap() {
    // max_steps 20 (>16, so the converge nudge engages) with a script that never finishes:
    // the nudge lands with 8 steps left, and the turn ends with a StepLimit gate event.
    let mut cfg = test_cfg();
    cfg.max_steps = 20;
    let steps: Vec<ScriptStep> = (0..20)
        .map(|_| ScriptStep::Turn(turn_tool("bash", serde_json::json!({ "command": "true" }))))
        .collect();
    let events = run_and_collect(&session_cfg(steps, cfg)).await;
    assert!(
        note_seen(&events, "8 of 20 steps remain"),
        "converge nudge missing: {events:?}"
    );
    assert!(
        events.iter().any(|e| matches!(e, AgentEvent::StepLimit(20))),
        "step gate event missing: {events:?}"
    );
}

#[tokio::test]
async fn compaction_fires_near_the_window_even_while_exploring() {
    // The near-window backstop: a read-only turn that approaches the context window MUST still
    // compact so a pathological pure-exploration turn can't overrun it. window 24k → 70% = 16.8k;
    // prompt_tokens 20k trips both the threshold and the backstop.
    let mut cfg = test_cfg();
    cfg.context_window = Some(24_000);
    let events = run_and_collect(&session_cfg(exploration_steps(), cfg)).await;
    assert!(note_seen(&events, "context compacted"), "near-window backstop must fire; {events:?}");
}

#[tokio::test]
async fn compaction_holds_during_readonly_exploration() {
    // No edits and no window info: pure exploration must NOT be compacted even past the threshold —
    // every read is design context until the model acts on it. (test_cfg has context_window None,
    // so the near-window backstop can't fire either.)
    let events = run_and_collect(&session(exploration_steps())).await;
    assert!(
        !note_seen(&events, "context compacted"),
        "read-only exploration must not be compacted below the window; {events:?}"
    );
}

#[test]
fn compaction_never_elides_a_result_the_model_has_not_seen() {
    // 10 tool results the model has seen (seen_before covers them) + 2 produced since. With
    // keep_recent=0 every SEEN result is eligible, but the 2 unseen ones must be untouched.
    let big = "y".repeat(300);
    let mut msgs = vec![ChatMessage::system("sys")];
    for i in 0..10 {
        msgs.push(tool_msg(&big, i));
    }
    let seen_before = msgs.len(); // the model was last sent everything up to here
    msgs.push(tool_msg(&big, 100));
    msgs.push(tool_msg(&big, 101));
    let elided = compact_history(&mut msgs, 0, seen_before);
    assert_eq!(elided, 10, "all seen results elide");
    assert!(msgs[11].content.as_deref().unwrap().starts_with('y'), "unseen result 1 intact");
    assert!(msgs[12].content.as_deref().unwrap().starts_with('y'), "unseen result 2 intact");
}

#[test]
fn estimate_prompt_tokens_scales_with_content() {
    let small = vec![ChatMessage::user("hi")];
    let big = vec![ChatMessage::user("x".repeat(4000))];
    assert!(estimate_prompt_tokens(&small) < 10);
    assert!(estimate_prompt_tokens(&big) >= 900); // ~4000/4
}

#[test]
fn cap_result_keeps_head_and_tail_under_the_cap() {
    assert_eq!(cap_result("short", 100), "short");
    let long = "A".to_string() + &"m".repeat(10_000) + "Z";
    let capped = cap_result(&long, 6000);
    assert!(capped.chars().count() < long.chars().count());
    assert!(capped.starts_with('A'), "head kept");
    assert!(capped.ends_with('Z'), "tail kept");
    assert!(capped.contains("truncated"));
}

#[test]
fn check_command_detection() {
    assert!(is_check_command("cargo test --lib", None));
    assert!(is_check_command("cd app && python -m pytest -q", None));
    assert!(!is_check_command("echo hello", None));
    assert!(is_check_command("echo hello", Some("echo hello")));
    assert!(is_check_command("bash -lc 'make verify'", Some("make verify")));
    // end-to-end / browser runners count as checks
    assert!(is_check_command("bunx playwright test", None));
    assert!(is_check_command("npm run test:e2e", None));
    assert!(is_check_command("yarn cypress run", None));
}

#[tokio::test]
async fn a_failed_web_check_does_not_clear_the_assess_gate() {
    // web_check is treated as frontend verification, but only a PASSING one clears the gate.
    let dir = temp_root("webcheck-gate");
    let sess = session_in(
        dir.to_str().unwrap(),
        vec![
            ScriptStep::Turn(turn_tool("write_file", serde_json::json!({ "path": "app.js", "content": "x" }))),
            ScriptStep::Turn(turn_tool("web_check", serde_json::json!({ "url": "http://localhost:1" }))),
            ScriptStep::Turn(turn_text("verified in the browser")),
        ],
        None,
    );
    // web_check will report ok=false here (nothing served), so it should NOT clear the gate —
    // an unverified edit remains, and the nudge fires. This proves ok-gating, not just presence.
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "ASSESS check"), 1, "{events:?}");
}

fn spear_notes(events: &[AgentEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Note(t) if t.contains("SPEAR checkpoint")))
        .count()
}

#[tokio::test]
async fn spear_nudge_fires_once_after_sustained_direct_execution() {
    // 14 direct tool calls (past SPEAR_NUDGE_AFTER=12), no delegation → exactly one advisory
    // nudge, entering committed history so the model sees it.
    let mut steps: Vec<ScriptStep> = (0..14)
        .map(|_| ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "Cargo.toml" }))))
        .collect();
    steps.push(ScriptStep::Turn(turn_text("done")));
    let sess = session(steps);
    let (events, deltas) = run_with_commit(&sess).await;

    assert_eq!(spear_notes(&events), 1, "one nudge, not repeated: {events:?}");
    assert!(deltas.iter().flatten().any(|m| m.role == "user"
        && m.content.as_deref().is_some_and(|c| c.contains("SPEAR checkpoint"))));
}

#[tokio::test]
async fn spear_nudge_skipped_when_the_turn_delegates_or_stays_short() {
    // Delegating early suppresses the nudge entirely…
    let mut steps = vec![
        ScriptStep::Turn(turn_delegate(&["investigate"])),
        ScriptStep::Turn(turn_text("subagent result")),
    ];
    steps.extend(
        (0..10).map(|_| {
            ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "Cargo.toml" })))
        }),
    );
    steps.push(ScriptStep::Turn(turn_text("done")));
    let sess = session(steps);
    let events = run_and_collect(&sess).await;
    assert_eq!(spear_notes(&events), 0, "delegation suppresses the nudge: {events:?}");

    // …and short direct turns never see it.
    let sess = session(vec![
        ScriptStep::Turn(turn_tool("read_file", serde_json::json!({ "path": "Cargo.toml" }))),
        ScriptStep::Turn(turn_text("done")),
    ]);
    let events = run_and_collect(&sess).await;
    assert_eq!(spear_notes(&events), 0);
}

#[tokio::test]
async fn usage_event_emitted_per_model_call() {
    let mut turn = turn_text("done");
    turn.usage = Some(TokenUsage {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cached_tokens: None,
    });
    let sess = session(vec![ScriptStep::Turn(turn)]);
    let events = run_and_collect(&sess).await;
    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::Usage(u) if u.total_tokens == 120 && u.prompt_tokens == 100
    )));
}

#[tokio::test]
async fn model_error_emits_error_event_and_ends_turn() {
    let sess = session(vec![ScriptStep::Err("upstream 503".into())]);
    let events = run_and_collect(&sess).await;
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::Error(m) if m.contains("upstream 503"))));
    // no Done after a hard error — the turn returns early
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Done)));
}

#[tokio::test]
async fn delegate_reports_failure_when_a_subagent_returns_an_error_result() {
    let sess = session(vec![
        ScriptStep::Turn(turn_delegate(&["do the thing"])),
        ScriptStep::Turn(turn_text("error: could not do the thing")),
        ScriptStep::Turn(turn_text("done")),
    ]);
    let events = run_and_collect(&sess).await;

    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::SubagentEnd { ok: false, .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::ToolEnd { ok: false, .. })));
}
