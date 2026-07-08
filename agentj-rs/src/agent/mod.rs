//! The model loop. Non-streaming: call the model, run the tools it asks for, repeat until it stops
//! calling tools (or hits the step cap). Two loop behaviors layered on top:
//!  - **Background jobs (primary loop only):** inject finished/timed-out job nudges each iteration; when
//!    the model goes idle with jobs still running, wait for the next nudge — but only when it has
//!    nothing else to do.
//!  - **Subagents:** a `run_subagents` tool call is intercepted here (not run through `tools.call`); each
//!    sub-task runs through a fresh `run_turn` with `allow_delegate=false` (depth cap 1). Independent
//!    sub-tasks run in parallel; only their final results re-enter the parent context.
//!
//! The concepts each have a submodule: `delegate` (the subagent fan-out) and `compact` (context
//! compaction). This file is the loop skeleton that wires them together.

mod agent_type;
mod compact;
mod delegate;

pub use agent_type::AgentType;

#[cfg(test)]
mod tests;

use crate::config::Config;
use crate::events::AgentEvent;
use crate::provider::{ChatMessage, Llm};
use crate::tools::{tool_specs, Tools};
use crate::util::first_line;
use async_recursion::async_recursion;
use compact::{compact_history, estimate_prompt_tokens, COMPACT_KEEP_RECENT};
use delegate::run_delegate;
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

/// The file-mutating tools. Once one has landed, compaction may start aging out older reads (before
/// that the turn is still read-only exploration and every read is live design context).
fn is_mutating_tool(name: &str) -> bool {
    matches!(name, "write_file" | "edit_file" | "edit_lines")
}

/// Resume — a `--resume`/`--continue` convenience, NOT a steering nudge. On the first turn of a
/// session that has surviving work, embed it so the model picks up where it left off instead of
/// re-deriving scope. It leads with `todos` (what's left) and follows with `plan` (the approach the
/// run committed to). Interactive sessions read the two artifacts from the global store; a headless
/// run reads its in-tree `.aj/task/plan.md`. A FRESH session has neither → nothing injected.
fn frontier_resume(sess: &Session) -> Option<String> {
    let cap = |s: String| -> String { s.trim().chars().take(4000).collect() };
    let mut parts: Vec<String> = Vec::new();
    match &sess.tools.session {
        Some(session) => {
            if let Some(t) = session.read_artifact("todos").map(cap).filter(|s| !s.is_empty()) {
                parts.push(format!("Your `todos` (what's left):\n{t}"));
            }
            if let Some(p) = session.read_artifact("plan").map(cap).filter(|s| !s.is_empty()) {
                parts.push(format!("Your `plan` (the approach):\n{p}"));
            }
        }
        None => {
            if let Some(p) = std::fs::read_to_string(sess.tools.root.join(".aj/task/plan.md"))
                .ok()
                .map(cap)
                .filter(|s| !s.is_empty())
            {
                parts.push(format!(".aj/task/plan.md:\n{p}"));
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "Work from this session survives — resume from it instead of re-deriving scope, and keep \
         your `todos` current as you go:\n\n{}",
        parts.join("\n\n")
    ))
}

/// Everything a turn needs to talk to the model and run tools, bundled so signatures stay small.
#[derive(Clone)]
pub struct Session {
    pub llm: Arc<Llm>,
    pub tools: Arc<Tools>,
    pub cfg: Arc<Config>,
}

/// Run one turn. `messages` already includes the system prompt, prior history, and the new user turn.
/// Events stream to `tx`. When `commit` is set, each newly appended message (or tool-call group) is
/// also sent through it as a delta, so the UI can fold completed steps into its history as the turn
/// progresses — an interrupted turn then keeps whatever already applied. Returns the model's final
/// assistant text (used as a subagent's result).
#[async_recursion]
pub async fn run_turn(
    sess: &Session,
    messages: &mut Vec<ChatMessage>,
    tx: &UnboundedSender<AgentEvent>,
    allow_delegate: bool,
    commit: Option<&UnboundedSender<Vec<ChatMessage>>>,
) -> String {
    let mut idle_nudges = 0usize;
    let mut final_text = String::new();
    let commit_delta = |delta: Vec<ChatMessage>| {
        if let Some(c) = commit {
            let _ = c.send(delta);
        }
    };
    // Inject a job/resume message into the turn: surfaced to the UI as a Note, committed to the
    // durable history, and appended for the model's next call.
    let inject = |messages: &mut Vec<ChatMessage>, msg: String, note_cap: usize| {
        let _ = tx.send(AgentEvent::Note(first_line(&msg, note_cap)));
        let m = ChatMessage::user(msg);
        commit_delta(vec![m.clone()]);
        messages.push(m);
    };
    // Once any file-mutating tool has landed, compaction may age out older reads; before that the
    // turn is read-only exploration and every read is live design context.
    let mut mutated = false;
    let mut last_prompt_tokens: u64 = 0;
    // Everything present when the turn begins was already shown to the model in prior turns; only
    // messages appended past this point are "unseen" and must not be compacted until sent.
    let mut seen_before = messages.len();

    // Frontier resume: on the FIRST turn of a session (history is exactly [system, prompt]) a
    // surviving task plan is embedded so the model resumes from it. Primary loop only; later turns
    // already carry that work in their history.
    if allow_delegate && messages.len() == 2 {
        if let Some(msg) = frontier_resume(sess) {
            inject(messages, msg, 120);
        }
        seen_before = messages.len();
    }

    let mut step = 0usize;
    let step_budget = sess.cfg.max_steps;
    loop {
        if step >= step_budget {
            let _ = tx.send(AgentEvent::StepLimit(sess.cfg.max_steps));
            let _ = tx.send(AgentEvent::Done);
            return final_text;
        }
        step += 1;

        // Background jobs are the primary loop's concern only (subagents don't consume nudges).
        if allow_delegate {
            for n in sess.tools.jobs.drain_nudges() {
                inject(messages, n, 100);
            }
        }

        // Context compaction: once a call's prompt exceeds the (absolute) threshold, elide older
        // already-seen tool-result bodies so a flailing turn's context stops re-growing every call.
        // Triggered by the accurate prior `prompt_tokens` OR a cheap size estimate (so the first call
        // of a turn with huge prior history compacts too). The durable (TUI) history keeps full text.
        //
        // But hold off while the turn is still READ-ONLY exploration: every read is design context
        // until the model starts acting on it, and eliding it there shreds the picture it needs to
        // design from. Once an edit has landed, older reads may age out. A near-window backstop still
        // fires regardless so a pathological pure-exploration turn can't overrun the context.
        let size = last_prompt_tokens.max(estimate_prompt_tokens(messages));
        let near_window = sess.cfg.context_window.is_some_and(|w| size > w * 7 / 10);
        if size > sess.cfg.compact_threshold && (mutated || near_window) {
            let n = compact_history(messages, COMPACT_KEEP_RECENT, seen_before);
            if n > 0 {
                let _ = tx.send(AgentEvent::Note(format!(
                    "context compacted — elided {n} older tool results"
                )));
            }
        }

        // Specs are recomputed each call: `mcp_find_tools` activates tools mid-turn, and their full
        // schemas must advertise on the very next call (subagents share the catalog via Tools).
        let mut specs = tool_specs(
            allow_delegate,
            sess.tools.has_session(),
            sess.tools.agent_type,
        );
        specs.extend(sess.tools.mcp_specs());
        // About to send the whole history — after this call, everything in it counts as seen.
        seen_before = messages.len();
        let turn = match sess.llm.chat(messages, &specs).await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(AgentEvent::Error(e.to_string()));
                return final_text;
            }
        };

        if let Some(usage) = turn.usage {
            last_prompt_tokens = usage.prompt_tokens;
            let _ = tx.send(AgentEvent::Usage(usage));
        }
        if turn.finish_reason == "length" {
            let _ = tx.send(AgentEvent::Note(
                "response truncated (finish_reason=length)".to_string(),
            ));
        }

        // Surface the model's reasoning (when the provider returns it) before its reply — a
        // `thinking` block. Display-only; it is not added to `messages`/history.
        if let Some(reasoning) = turn.reasoning.as_deref() {
            if !reasoning.trim().is_empty() {
                let _ = tx.send(AgentEvent::Thinking(reasoning.to_string()));
            }
        }

        if let Some(text) = turn.content.clone() {
            if !text.trim().is_empty() {
                let _ = tx.send(AgentEvent::Message(text.clone()));
            }
            final_text = text;
        }
        let assistant = ChatMessage {
            role: "assistant".into(),
            content: turn.content.clone(),
            tool_calls: turn.tool_calls.clone(),
            tool_call_id: None,
        };
        messages.push(assistant.clone());

        if turn.tool_calls.is_empty() {
            // A bare assistant reply commits on its own.
            commit_delta(vec![assistant]);

            // The model went idle. If background jobs are still running and it has nothing else to do,
            // wait for the next nudge and continue — it blocks only when there's nothing else to do.
            if allow_delegate
                && sess.tools.jobs.has_running()
                && idle_nudges < sess.cfg.max_idle_nudges
            {
                let _ = tx.send(AgentEvent::Note("waiting on a background job…".to_string()));
                match tokio::time::timeout(sess.cfg.idle_wait, sess.tools.jobs.next_nudge()).await {
                    Ok(n) => {
                        idle_nudges += 1;
                        inject(messages, n, 100);
                        continue;
                    }
                    Err(_) => {
                        let _ = tx.send(AgentEvent::Note("still waiting on a background job — ending the turn; job_check it next time.".to_string()));
                    }
                }
            }

            let _ = tx.send(AgentEvent::Done);
            return final_text;
        }

        // Commit the assistant message and all its tool replies together, so an interrupt can't leave
        // a dangling `tool_calls` request without its matching tool responses in the committed history.
        let mut delta = vec![assistant];
        for tc in &turn.tool_calls {
            let args: Value = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_else(|_| serde_json::json!({}));

            // `run_subagents` is intercepted here (not run through tools.call) so it can spawn nested loops.
            let is_delegate = allow_delegate && tc.function.name == "run_subagents";
            let _ = tx.send(AgentEvent::ToolStart {
                name: tc.function.name.clone(),
                args: first_line(&tc.function.arguments, 100),
                step,
            });
            let start = Instant::now();
            let (text, ok) = if is_delegate {
                run_delegate(sess, &args, tx).await
            } else {
                let o = sess.tools.call(&tc.function.name, &args).await;
                (o.text, o.ok)
            };
            let _ = tx.send(AgentEvent::ToolEnd {
                ok,
                elapsed_ms: start.elapsed().as_millis(),
                summary: first_line(&text, 60),
            });
            if ok && is_mutating_tool(&tc.function.name) {
                mutated = true;
            }
            let tool_msg = ChatMessage {
                role: "tool".into(),
                content: Some(text),
                tool_calls: vec![],
                tool_call_id: Some(tc.id.clone()),
            };
            messages.push(tool_msg.clone());
            delta.push(tool_msg);
        }
        commit_delta(delta);
    }
}
