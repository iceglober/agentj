//! Delegation: a `run_subagents` tool call fans sub-tasks out to subagents that each run through a
//! fresh `run_turn` in their own context (depth cap 1 — subagents can't re-delegate). Independent
//! sub-tasks run in parallel, bounded by a semaphore; only their final results re-enter the parent
//! context, forwarded live to the UI as structured `Subagent*` events along the way.

use super::{run_turn, AgentType, Session};
use crate::events::AgentEvent;
use crate::provider::ChatMessage;
use crate::util::first_line;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

/// One subagent's outcome: its batch index, final result text, and whether it succeeded.
struct SubResult {
    index: usize,
    result: String,
    ok: bool,
}

/// Ceiling on how much of each subagent's result re-enters the parent context. Subagents are told to
/// return a tight self-contained result, but nothing enforces it — an over-long one would bloat the
/// parent's context (the exact thing delegation exists to avoid). Keeps the head (where the answer
/// and changed-files summary sit) plus a short tail, over char (not byte) boundaries.
const SUBAGENT_RESULT_CAP: usize = 6000;

pub(super) fn cap_result(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let head: String = s.chars().take(cap * 3 / 4).collect();
    let tail: String = {
        let t: Vec<char> = s.chars().collect();
        t[t.len() - cap / 4..].iter().collect()
    };
    format!("{head}\n… [subagent result truncated — {} chars omitted] …\n{tail}", s.chars().count() - cap)
}

/// The label a subagent shows in the tray: the model-supplied `title` when present, else the first
/// sentence of the task (so instruction boilerplate like "Return a tight factual summary…" doesn't
/// ride along), capped for sanity.
pub(super) fn task_label(task: &str, title: Option<&str>) -> String {
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        return first_line(t, 80);
    }
    let line = first_line(task, 400);
    let sentence = match line.find(". ") {
        Some(i) => line[..=i].trim_end(),
        None => line.as_str(),
    };
    if sentence.chars().count() > 100 {
        format!("{}…", sentence.chars().take(99).collect::<String>())
    } else {
        sentence.to_string()
    }
}

/// Run each `{ task, context? }` in `args.tasks` as a subagent, in parallel (bounded). Each sub-task's
/// progress is forwarded to `tx` as structured `Subagent*` events. Returns the labeled results joined
/// together for the model, plus whether every sub-task succeeded (for the delegate `ToolEnd.ok`).
pub(super) async fn run_delegate(
    sess: &Session,
    args: &Value,
    tx: &UnboundedSender<AgentEvent>,
) -> (String, bool) {
    let tasks: Vec<(String, Option<String>, String, AgentType)> = args
        .get("tasks")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let task = t.get("task").and_then(|x| x.as_str())?.to_string();
                    let context = t
                        .get("context")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string());
                    let label = task_label(&task, t.get("title").and_then(|x| x.as_str()));
                    let kind = AgentType::parse(t.get("type").and_then(|x| x.as_str()));
                    Some((task, context, label, kind))
                })
                .collect()
        })
        .unwrap_or_default();
    if tasks.is_empty() {
        return (
            "error: run_subagents needs a non-empty `tasks` array of { task, context? }".to_string(),
            false,
        );
    }

    let _ = tx.send(AgentEvent::Note(format!(
        "delegating {} sub-task(s) in parallel",
        tasks.len()
    )));
    let cwd = sess.tools.root.to_string_lossy().into_owned();
    let sem = Arc::new(Semaphore::new(sess.cfg.max_parallel_subagents));
    let mut set: JoinSet<SubResult> = JoinSet::new();
    let mut task_index: HashMap<tokio::task::Id, usize> = HashMap::new();

    for (i, (task, context, label, kind)) in tasks.into_iter().enumerate() {
        // Each subagent runs in a Session scoped to its TYPE: a tool set the type allows, and the
        // type's role prompt (both keep its context lean and its behavior on-rails).
        let sub_sess = Session {
            llm: sess.llm.clone(),
            tools: Arc::new(sess.tools.scoped_to(kind)),
            cfg: sess.cfg.clone(),
        };
        let sub_system = crate::prompt::subagent_system_prompt(kind, &cwd);
        let parent = tx.clone();
        let sem = sem.clone();
        let handle = set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let _ = parent.send(AgentEvent::SubagentStart { id: i, desc: label });
            let started = Instant::now();
            let prompt = match context {
                Some(c) => format!("{task}\n\nContext:\n{c}"),
                None => task,
            };
            let mut sub_msgs = vec![
                ChatMessage::system(sub_system),
                ChatMessage::user(prompt),
            ];
            let (atx, mut arx) = unbounded_channel::<AgentEvent>();

            let fwd = parent.clone();
            let forward = async move {
                let mut saw_error = false;
                let mut sub_tokens: u64 = 0; // input tokens this subagent spent (for the budget meter)
                while let Some(ev) = arx.recv().await {
                    // Subagent Usage is re-emitted as SubagentUsage — never as a top-level Usage,
                    // which would corrupt the primary loop's context-fill meter. The full per-call
                    // usage (in/out/cached) reaches the session accounting this way.
                    if let AgentEvent::Usage(u) = &ev {
                        sub_tokens += u.prompt_tokens;
                        let _ = fwd.send(AgentEvent::SubagentUsage { id: i, usage: *u });
                    }
                    let status = match ev {
                        AgentEvent::ToolStart { name, args, .. } => Some(format!("{name}({args})")),
                        AgentEvent::Message(t) => Some(first_line(&t, 80)),
                        AgentEvent::Note(t) => Some(t),
                        AgentEvent::Error(e) => {
                            saw_error = true;
                            Some(format!("error: {e}"))
                        }
                        _ => None,
                    };
                    if let Some(status) = status {
                        let _ = fwd.send(AgentEvent::SubagentProgress { id: i, status });
                    }
                }
                (saw_error, sub_tokens)
            };
            let run = async {
                // Subagents don't commit deltas — only their final result re-enters the parent.
                let r = run_turn(&sub_sess, &mut sub_msgs, &atx, false, None).await;
                drop(atx); // close the channel so the forwarder finishes
                r
            };
            let (result, (saw_error, sub_tokens)) = tokio::join!(run, forward);
            let ok = !saw_error && !result.trim_start().starts_with("error:");
            let mut summary = first_line(&result, 80);
            if sub_tokens > 0 {
                // The " · N tok" suffix is what the TUI tray and the eval harness read per subagent.
                summary = format!("{summary} · {sub_tokens} tok");
            }
            let _ = parent.send(AgentEvent::SubagentEnd {
                id: i,
                ok,
                summary,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
            SubResult {
                index: i,
                result,
                ok,
            }
        });
        task_index.insert(handle.id(), i);
    }

    let mut results: Vec<SubResult> = Vec::new();
    while let Some(joined) = set.join_next_with_id().await {
        match joined {
            Ok((_, sub)) => results.push(sub),
            Err(join_err) => {
                // A subagent task panicked or was cancelled — surface it instead of a silent gap.
                let index = task_index.get(&join_err.id()).copied().unwrap_or(usize::MAX);
                let _ = tx.send(AgentEvent::SubagentEnd {
                    id: index,
                    ok: false,
                    summary: format!("subagent task failed: {join_err}"),
                    elapsed_ms: 0,
                });
                results.push(SubResult {
                    index,
                    result: format!("error: subagent task failed: {join_err}"),
                    ok: false,
                });
            }
        }
    }
    results.sort_by_key(|s| s.index);
    let all_ok = results.iter().all(|s| s.ok);
    let joined = results
        .into_iter()
        .map(|s| {
            let body = if s.result.trim().is_empty() {
                "(no result)".to_string()
            } else {
                cap_result(&s.result, SUBAGENT_RESULT_CAP)
            };
            format!("[subagent {}] {}", s.index, body)
        })
        .collect::<Vec<_>>()
        .join("\n---\n");
    (joined, all_ok)
}
