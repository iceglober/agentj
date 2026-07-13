//! Delegation: a `run_subagents` tool call fans sub-tasks out to subagents that each run through a
//! fresh `run_turn` in their own context (depth cap 1 — subagents can't re-delegate). It's a small
//! dependency DAG: independent tasks run in parallel (bounded by a semaphore), while a task with
//! `after:[…]` runs in a later STAGE, fed the results of its prerequisites — so a planner can depend
//! on the scouts that feed it. Only final results re-enter the parent context, forwarded live to the
//! UI as structured `Subagent*` events along the way.

use super::{run_turn, worktree::WorktreeLease, AgentType, Session};
use crate::events::AgentEvent;
use crate::provider::ChatMessage;
use crate::util::first_line;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
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
    format!(
        "{head}\n… [subagent result truncated — {} chars omitted] …\n{tail}",
        s.chars().count() - cap
    )
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

/// One parsed sub-task. `after` holds the indices of sub-tasks it depends on — it runs in a LATER
/// stage, fed their results.
struct TaskDef {
    task: String,
    context: Option<String>,
    label: String,
    kind: AgentType,
    worktree: bool,
    after: Vec<usize>,
}

fn parse_tasks(args: &Value) -> Vec<TaskDef> {
    args.get("tasks")
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
                    let worktree = t.get("worktree").and_then(|x| x.as_bool()).unwrap_or(false);
                    let after = t
                        .get("after")
                        .and_then(|x| x.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_u64().map(|n| n as usize))
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(TaskDef {
                        task,
                        context,
                        label,
                        kind,
                        worktree,
                        after,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn validate_tasks(tasks: &[TaskDef]) -> Result<(), String> {
    for (i, task) in tasks.iter().enumerate() {
        if task.worktree && task.kind != AgentType::Executor {
            return Err(format!(
                "run_subagents: task {i} sets worktree:true but only executor subagents may request isolated worktrees"
            ));
        }
    }
    Ok(())
}

/// Dependency depth of each task: 0 for independent tasks, else 1 + the max depth of its `after`
/// prerequisites. Tasks at the same depth run in parallel; depths run in order. Errors on an
/// out-of-range/self dependency or a cycle. Memoized DFS.
fn stage_levels(tasks: &[TaskDef]) -> Result<Vec<usize>, String> {
    let n = tasks.len();
    for (i, t) in tasks.iter().enumerate() {
        for &d in &t.after {
            if d >= n {
                return Err(format!(
                    "run_subagents: task {i} lists after:[…{d}…] but there are only {n} tasks (0-based)"
                ));
            }
            if d == i {
                return Err(format!("run_subagents: task {i} can't depend on itself"));
            }
        }
    }
    fn depth(
        i: usize,
        tasks: &[TaskDef],
        memo: &mut [Option<usize>],
        on_stack: &mut [bool],
    ) -> Result<usize, String> {
        if let Some(l) = memo[i] {
            return Ok(l);
        }
        if on_stack[i] {
            return Err("run_subagents: the `after` dependencies form a cycle".to_string());
        }
        on_stack[i] = true;
        let mut lv = 0;
        for &d in &tasks[i].after {
            lv = lv.max(depth(d, tasks, memo, on_stack)? + 1);
        }
        on_stack[i] = false;
        memo[i] = Some(lv);
        Ok(lv)
    }
    let mut memo = vec![None; n];
    let mut on_stack = vec![false; n];
    for i in 0..n {
        depth(i, tasks, &mut memo, &mut on_stack)?;
    }
    Ok(memo.into_iter().map(|l| l.unwrap()).collect())
}

async fn await_subagent_run<F>(
    run: tokio::task::JoinHandle<String>,
    forward: F,
) -> (String, bool, u64)
where
    F: Future<Output = (bool, u64)>,
{
    let (run_result, (saw_error, sub_tokens)) = tokio::join!(run, forward);
    let run_ok = run_result.is_ok();
    let result = match run_result {
        Ok(result) => result,
        Err(join_err) => format!("error: subagent task failed: {join_err}"),
    };
    let ok = run_ok && !saw_error && !result.trim_start().starts_with("error:");
    (result, ok, sub_tokens)
}

/// Run the `tasks` in `args.tasks` as subagents. Independent tasks run in PARALLEL (bounded); a task
/// with `after:[…]` runs in a later STAGE, fed the results of its prerequisites — so a planner can
/// depend on the scouts that feed it. Progress forwards to `tx` as `Subagent*` events. Returns the
/// labeled results joined for the model, plus whether every sub-task succeeded.
pub(super) async fn run_delegate(
    sess: &Session,
    args: &Value,
    tx: &UnboundedSender<AgentEvent>,
) -> (String, bool) {
    let tasks = parse_tasks(args);
    if tasks.is_empty() {
        return (
            "error: run_subagents needs a non-empty `tasks` array of { task, context?, after? }"
                .to_string(),
            false,
        );
    }
    if let Err(err) = validate_tasks(&tasks) {
        return (format!("error: {err}"), false);
    }
    let n = tasks.len();
    let levels = match stage_levels(&tasks) {
        Ok(l) => l,
        Err(e) => return (format!("error: {e}"), false),
    };
    let stages = levels.iter().copied().max().unwrap_or(0) + 1;

    let _ = tx.send(AgentEvent::Note(if stages == 1 {
        format!("delegating {n} sub-task(s) in parallel")
    } else {
        format!("delegating {n} sub-task(s) across {stages} dependency stage(s)")
    }));
    let sem = Arc::new(Semaphore::new(sess.cfg.max_parallel_subagents));
    // Each task's (result, ok), by index — filled as stages complete so later stages can read deps.
    let mut results: Vec<Option<(String, bool)>> = vec![None; n];

    for stage in 0..stages {
        let mut set: JoinSet<SubResult> = JoinSet::new();
        let mut task_index: HashMap<tokio::task::Id, usize> = HashMap::new();

        for i in (0..n).filter(|&i| levels[i] == stage) {
            let def = &tasks[i];
            // Feed this task the results of the sub-tasks it depends on, then any explicit context.
            let mut ctx_parts: Vec<String> = def
                .after
                .iter()
                .filter_map(|&d| {
                    results[d].as_ref().map(|(res, _)| {
                        format!(
                            "[result from sub-task {d} — {}]\n{}",
                            tasks[d].label,
                            cap_result(res, SUBAGENT_RESULT_CAP)
                        )
                    })
                })
                .collect();
            if let Some(c) = &def.context {
                ctx_parts.push(c.clone());
            }
            let injected = (!ctx_parts.is_empty()).then(|| ctx_parts.join("\n\n"));
            let task = def.task.clone();
            let label = def.label.clone();
            let kind = def.kind;
            let worktree = def.worktree;
            let parent = tx.clone();
            let sem = sem.clone();
            let llm = sess.llm.clone();
            let cfg = sess.cfg.clone();
            let tools = sess.tools.clone();
            let parent_root = sess.tools.root.clone();
            let handle = set.spawn(async move {
                let _permit = sem.acquire_owned().await;
                let _ = parent.send(AgentEvent::SubagentStart {
                    id: i,
                    desc: label,
                    agent_type: kind.as_str().to_string(),
                });
                let started = Instant::now();
                let lease = if worktree {
                    let root = parent_root.to_string_lossy().into_owned();
                    match WorktreeLease::new(&root).await {
                        Ok(lease) => Some(lease),
                        Err(err) => {
                            let result =
                                format!("error: failed to create isolated worktree: {err}");
                            let _ = parent.send(AgentEvent::SubagentEnd {
                                id: i,
                                ok: false,
                                summary: first_line(&result, 80),
                                elapsed_ms: started.elapsed().as_millis() as u64,
                            });
                            return SubResult {
                                index: i,
                                result,
                                ok: false,
                            };
                        }
                    }
                } else {
                    None
                };
                // Each subagent runs in a Session scoped to its TYPE: a tool set the type allows, and the
                // type's role prompt (both keep its context lean and its behavior on-rails).
                let (sub_sess, lane_cwd) = if let Some(lease) = &lease {
                    let root = lease.root.clone();
                    let cwd = root.to_string_lossy().into_owned();
                    (
                        Session {
                            llm,
                            tools: Arc::new(tools.scoped_to_root(kind, root)),
                            cfg,
                        },
                        cwd,
                    )
                } else {
                    let cwd = parent_root.to_string_lossy().into_owned();
                    (
                        Session {
                            llm,
                            tools: Arc::new(tools.scoped_to(kind)),
                            cfg,
                        },
                        cwd,
                    )
                };
                let sub_system = crate::prompt::subagent_system_prompt(kind, &lane_cwd);
                let prompt = match injected {
                    Some(c) => format!("{task}\n\nContext:\n{c}"),
                    None => task,
                };
                let mut sub_msgs = vec![ChatMessage::system(sub_system), ChatMessage::user(prompt)];
                let (atx, mut arx) = unbounded_channel::<AgentEvent>();

                let fwd = parent.clone();
                let forward = async move {
                    let mut saw_error = false;
                    let mut sub_tokens: u64 = 0; // input tokens this subagent spent (budget meter)
                    while let Some(ev) = arx.recv().await {
                        // Subagent Usage is re-emitted as SubagentUsage — never a top-level Usage,
                        // which would corrupt the primary loop's context-fill meter.
                        if let AgentEvent::Usage(u) = &ev {
                            sub_tokens += u.prompt_tokens;
                            let _ = fwd.send(AgentEvent::SubagentUsage { id: i, usage: *u });
                        }
                        let status = match ev {
                            AgentEvent::ToolStart { name, args, .. } => {
                                Some(format!("{name}({args})"))
                            }
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
                let jobs = sub_sess.tools.jobs.clone();
                let run = tokio::spawn(async move {
                    // Subagents don't commit deltas — only their final result re-enters the parent.
                    let result = run_turn(&sub_sess, &mut sub_msgs, &atx, false, None).await;
                    drop(atx); // close the channel so the forwarder finishes on normal return
                    result
                });
                let (mut result, ok, sub_tokens) = await_subagent_run(run, forward).await;
                if let Some(lease) = lease {
                    let lease_root = lease.root.clone();
                    let finalization = if jobs.has_running_in(&lease_root).await {
                        lease.preserve(format!(
                            "live background job still running in isolated lane `{}`",
                            lease_root.display()
                        ))
                    } else {
                        lease.finalize().await
                    };
                    result.push_str(&format!(
                        "\n\n--- isolated worktree ---\n{}\n--- end isolated worktree ---",
                        finalization.parent_note()
                    ));
                }
                let mut summary = first_line(&result, 80);
                if sub_tokens > 0 {
                    // The " · N tok" suffix is what the TUI tray and eval harness read per subagent.
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

        // Barrier: finish this stage before the next (dependents read these results).
        while let Some(joined) = set.join_next_with_id().await {
            match joined {
                Ok((_, sub)) => results[sub.index] = Some((sub.result, sub.ok)),
                Err(join_err) => {
                    let index = task_index
                        .get(&join_err.id())
                        .copied()
                        .unwrap_or(usize::MAX);
                    let _ = tx.send(AgentEvent::SubagentEnd {
                        id: index,
                        ok: false,
                        summary: format!("subagent task failed: {join_err}"),
                        elapsed_ms: 0,
                    });
                    if let Some(slot) = results.get_mut(index) {
                        *slot = Some((format!("error: subagent task failed: {join_err}"), false));
                    }
                }
            }
        }
    }

    let all_ok = results
        .iter()
        .all(|r| r.as_ref().is_some_and(|(_, ok)| *ok));
    let joined = (0..n)
        .map(|i| {
            let body = match &results[i] {
                Some((res, _)) if !res.trim().is_empty() => cap_result(res, SUBAGENT_RESULT_CAP),
                _ => "(no result)".to_string(),
            };
            format!("[subagent {i}] {body}")
        })
        .collect::<Vec<_>>()
        .join("\n---\n");
    (joined, all_ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::TokenUsage;
    use tokio::sync::mpsc::unbounded_channel;

    fn defs(afters: &[&[usize]]) -> Vec<TaskDef> {
        afters
            .iter()
            .map(|a| TaskDef {
                task: String::new(),
                context: None,
                label: String::new(),
                kind: AgentType::Executor,
                worktree: false,
                after: a.to_vec(),
            })
            .collect()
    }

    #[test]
    fn parse_tasks_reads_optional_worktree_flag() {
        let args = serde_json::json!({
            "tasks": [
                { "task": "shared lane" },
                { "task": "isolated lane", "type": "executor", "worktree": true }
            ]
        });

        let tasks = parse_tasks(&args);
        assert_eq!(tasks.len(), 2);
        assert!(!tasks[0].worktree);
        assert_eq!(tasks[0].kind, AgentType::Executor);
        assert!(tasks[1].worktree);
        assert_eq!(tasks[1].kind, AgentType::Executor);
    }

    #[test]
    fn validate_tasks_rejects_isolated_non_executor_lanes() {
        let tasks = vec![TaskDef {
            task: "inspect".to_string(),
            context: None,
            label: "inspect".to_string(),
            kind: AgentType::Scout,
            worktree: true,
            after: vec![],
        }];

        let err = validate_tasks(&tasks).unwrap_err();
        assert!(err.contains("worktree:true"));
        assert!(err.contains("executor"));
    }

    #[test]
    fn independent_tasks_are_all_stage_zero() {
        assert_eq!(
            stage_levels(&defs(&[&[], &[], &[]])).unwrap(),
            vec![0, 0, 0]
        );
    }

    #[test]
    fn a_dependent_task_runs_after_its_prerequisites() {
        // scouts 0 and 1 at stage 0; planner 2 depends on both → stage 1.
        assert_eq!(
            stage_levels(&defs(&[&[], &[], &[0, 1]])).unwrap(),
            vec![0, 0, 1]
        );
        // a chain 0 → 1 → 2 stages each one deeper.
        assert_eq!(
            stage_levels(&defs(&[&[], &[0], &[1]])).unwrap(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn cycles_and_bad_indices_are_rejected() {
        assert!(stage_levels(&defs(&[&[1], &[0]])).is_err(), "cycle 0↔1");
        assert!(stage_levels(&defs(&[&[0]])).is_err(), "self-dependency");
        assert!(stage_levels(&defs(&[&[5]])).is_err(), "out-of-range index");
    }

    #[tokio::test]
    async fn await_subagent_run_keeps_usage_from_forwarder_on_success() {
        let (atx, mut arx) = unbounded_channel::<AgentEvent>();
        let run = tokio::spawn(async move {
            let _ = atx.send(AgentEvent::Usage(TokenUsage {
                prompt_tokens: 17,
                completion_tokens: 3,
                total_tokens: 20,
                cached_tokens: None,
            }));
            drop(atx);
            "done".to_string()
        });
        let forward = async move {
            let mut saw_error = false;
            let mut sub_tokens: u64 = 0;
            while let Some(ev) = arx.recv().await {
                if let AgentEvent::Usage(u) = &ev {
                    sub_tokens += u.prompt_tokens;
                }
                if matches!(ev, AgentEvent::Error(_)) {
                    saw_error = true;
                }
            }
            (saw_error, sub_tokens)
        };

        let (result, ok, sub_tokens) = await_subagent_run(run, forward).await;

        assert_eq!(result, "done");
        assert!(ok);
        assert_eq!(sub_tokens, 17);
    }

    #[tokio::test]
    async fn await_subagent_run_converts_nested_panics_into_failed_results() {
        let (atx, mut arx) = unbounded_channel::<AgentEvent>();
        let run = tokio::spawn(async move {
            let _ = atx.send(AgentEvent::Usage(TokenUsage {
                prompt_tokens: 11,
                completion_tokens: 0,
                total_tokens: 11,
                cached_tokens: None,
            }));
            panic!("boom");
            #[allow(unreachable_code)]
            {
                "unreachable".to_string()
            }
        });
        let forward = async move {
            let mut saw_error = false;
            let mut sub_tokens: u64 = 0;
            while let Some(ev) = arx.recv().await {
                if let AgentEvent::Usage(u) = &ev {
                    sub_tokens += u.prompt_tokens;
                }
                if matches!(ev, AgentEvent::Error(_)) {
                    saw_error = true;
                }
            }
            (saw_error, sub_tokens)
        };

        let (result, ok, sub_tokens) = await_subagent_run(run, forward).await;

        assert!(!ok);
        assert_eq!(sub_tokens, 11);
        assert!(result.starts_with("error: subagent task failed:"));
    }
}
