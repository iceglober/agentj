use super::compact::{compact_history, estimate_prompt_tokens};
use super::delegate::{cap_result, task_label};
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
fn run_subagents_spec_is_gated_by_role() {
    let primary = tool_specs(true, false, None);
    let subagent = tool_specs(false, true, None);
    // The primary loop may fan out to subagents.
    assert!(primary.iter().any(|s| s.name == "run_subagents"));
    // Subagents never get it (allow_delegate=false → depth cap 1).
    assert!(!subagent.iter().any(|s| s.name == "run_subagents"));
    // job tools are present in both.
    assert!(primary.iter().any(|s| s.name == "job_start"));
    assert!(subagent.iter().any(|s| s.name == "job_start"));
}

#[test]
fn artifact_specs_require_a_session_and_the_primary_loop() {
    // Only the interactive primary (allow_delegate && has_session) gets the artifact tools.
    let with_session = tool_specs(true, true, None);
    assert!(with_session.iter().any(|s| s.name == "save_artifact"));
    assert!(with_session.iter().any(|s| s.name == "read_artifact"));
    // No session (headless) → no artifact tools.
    assert!(!tool_specs(true, false, None).iter().any(|s| s.name == "save_artifact"));
    // Subagents never get them even with a session attached.
    assert!(!tool_specs(false, true, None).iter().any(|s| s.name == "save_artifact"));
}

fn test_cfg() -> Config {
    Config {
        max_steps: 40,
        max_idle_nudges: 6,
        idle_wait: Duration::from_secs(120),
        max_parallel_subagents: 4,
        context_window: None,
        compact_threshold: 12_000,
        continuation_judge: false, // off by default in unit tests; opted in per-test
        host_manages_jobs: false,
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
        reasoning: None,
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
        reasoning: None,
        tool_calls: vec![ToolCall {
            id: "call_1".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: "run_subagents".into(),
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
        reasoning: None,
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
        reasoning: None,
            tool_calls: vec![ToolCall {
                id: "c1".into(),
                kind: "function".into(),
                function: FunctionCall {
                    name: "run_subagents".into(),
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

fn session_in(root: &str, steps: Vec<ScriptStep>) -> Session {
    let jobs = JobManager::new(root.to_string());
    let tools = Tools::new(PathBuf::from(root), jobs, None);
    Session {
        llm: Arc::new(Llm::Script(std::sync::Mutex::new(VecDeque::from(steps)))),
        tools: Arc::new(tools),
        cfg: Arc::new(test_cfg()),
    }
}

/// An interactive session with an attached artifact store (rooted at an explicit dir, no HOME).
/// If `plan` is set, it's pre-saved as the `plan` artifact so the frontier can resume from it.
fn session_with_store(steps: Vec<ScriptStep>, store_dir: &std::path::Path, plan: Option<&str>) -> Session {
    let store = crate::session::Session::at_dir(store_dir.to_path_buf());
    if let Some(p) = plan {
        store.save_artifact("plan", p).unwrap();
    }
    let jobs = JobManager::new(".".to_string());
    let tools = Tools::with_session(PathBuf::from("."), jobs, None, Some(Arc::new(store)));
    Session {
        llm: Arc::new(Llm::Script(std::sync::Mutex::new(VecDeque::from(steps)))),
        tools: Arc::new(tools),
        cfg: Arc::new(test_cfg()),
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
async fn a_surviving_frontier_is_injected_on_the_first_turn_only() {
    // A frontier file from a prior session → `frontier_resume` embeds it before the first model
    // call, so the model resumes the plan instead of re-scoping.
    let dir = temp_root("frontier");
    std::fs::create_dir_all(dir.join(".aj/task")).unwrap();
    std::fs::write(dir.join(".aj/task/plan.md"), "## pending\n- port the parser").unwrap();
    let sess = session_in(dir.to_str().unwrap(), vec![ScriptStep::Turn(turn_text("resuming"))]);
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "re-deriving scope"), 1, "{events:?}");

    // No frontier on disk → no injection.
    let dir2 = temp_root("frontier-none");
    let sess = session_in(dir2.to_str().unwrap(), vec![ScriptStep::Turn(turn_text("hi"))]);
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "re-deriving scope"), 0, "{events:?}");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

#[test]
fn resume_leads_with_todos_then_plan() {
    let dir = temp_root("resume-order");
    let store = crate::session::Session::at_dir(dir.clone());
    store.save_artifact("plan", "APPROACH: rewrite the parser").unwrap();
    store.save_artifact("todos", "- [ ] port lexer\n- [x] scaffold").unwrap();
    let jobs = JobManager::new(".".to_string());
    let tools = Tools::with_session(PathBuf::from("."), jobs, None, Some(Arc::new(store)));
    let sess = Session {
        llm: Arc::new(Llm::Script(std::sync::Mutex::new(VecDeque::new()))),
        tools: Arc::new(tools),
        cfg: Arc::new(test_cfg()),
    };
    let msg = super::frontier_resume(&sess).expect("a resume payload when work survives");
    let todos_at = msg.find("port lexer").expect("todos content present");
    let plan_at = msg.find("rewrite the parser").expect("plan content present");
    assert!(todos_at < plan_at, "todos (what's left) leads the approach: {msg}");
    assert!(msg.contains("`todos` (what's left)"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn interactive_frontier_comes_from_the_session_plan_artifact_not_the_repo() {
    // Resume: an attached session with a saved `plan` artifact injects it on the first turn.
    let store = temp_root("store-resume");
    let sess = session_with_store(
        vec![ScriptStep::Turn(turn_text("resuming"))],
        &store,
        Some("## pending\n- finish the migration"),
    );
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "re-deriving scope"), 1, "resumed from the artifact: {events:?}");

    // Fresh: an attached session with NO plan artifact injects nothing — a new session never
    // inherits an old task, which is the whole point.
    let store2 = temp_root("store-fresh");
    let sess = session_with_store(vec![ScriptStep::Turn(turn_text("brand new task"))], &store2, None);
    let events = run_and_collect(&sess).await;
    assert_eq!(notes_containing(&events, "re-deriving scope"), 0, "a fresh session inherits nothing: {events:?}");
    let _ = std::fs::remove_dir_all(&store);
    let _ = std::fs::remove_dir_all(&store2);
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
