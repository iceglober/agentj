//! Events the agent loop emits to the UI. Port of `events.ts` (AgentEvent).

use crate::provider::TokenUsage;

#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// A chunk of assistant text (one per model step).
    Message(String),
    /// A tool call started.
    ToolStart { name: String, args: String },
    /// A tool call finished. `ok` is false when the tool reported failure.
    ToolEnd {
        ok: bool,
        elapsed_ms: u128,
        summary: String,
    },
    /// A subagent (delegate sub-task) started. `id` is its 0-based index in the batch.
    SubagentStart { id: usize, desc: String },
    /// A subagent made progress — its current tool call or the latest message snippet.
    SubagentProgress { id: usize, status: String },
    /// A subagent finished. `ok` is false when it errored or its task panicked.
    SubagentEnd {
        id: usize,
        ok: bool,
        summary: String,
        elapsed_ms: u64,
    },
    /// Token accounting for the model call just completed.
    Usage(TokenUsage),
    /// A supervisor/lifecycle note (auto-continue, hit the cap, …).
    Note(String),
    /// The turn exhausted its step budget with work possibly unfinished — a gate, not a wall: the
    /// UI offers a one-key continue (history is intact, so a fresh turn resumes cleanly).
    StepLimit(usize),
    /// A hard error ended the turn.
    Error(String),
    /// The turn finished (natural completion or clean stop).
    Done,
}
