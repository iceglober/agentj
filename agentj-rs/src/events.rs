//! Events the agent loop emits to the UI. Port of `events.ts` (AgentEvent).

use crate::provider::TokenUsage;

/// One option of an [`AskQuestion`] — a short label plus an optional explanation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AskOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One structured question from the `ask_user` tool. `header` is a short chip/tag (e.g. "Plan
/// gate"); the recommended option comes FIRST in `options` by convention.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AskQuestion {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default)]
    pub options: Vec<AskOption>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum AgentEvent {
    /// A chunk of assistant text (one per model step).
    Message(String),
    /// A tool call started. `step` is the model round-trip it belongs to — several calls sharing a
    /// step were returned in ONE response, and the UI marks them as a batch.
    ToolStart {
        name: String,
        args: String,
        step: usize,
    },
    /// A tool call finished. `ok` is false when the tool reported failure. `summary` is the one-line
    /// digest (shown collapsed); `result` is the fuller output (capped), for a UI that expands a row.
    ToolEnd {
        ok: bool,
        elapsed_ms: u128,
        summary: String,
        result: String,
    },
    /// A subagent (delegate sub-task) started. `id` is its 0-based index in the batch.
    SubagentStart { id: usize, desc: String, agent_type: String },
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
    /// Token accounting for one model call inside a subagent. Kept distinct from `Usage` so the
    /// primary loop's context-fill meter never counts subagent spend, while session totals still do.
    SubagentUsage { id: usize, usage: TokenUsage },
    /// The model's reasoning for the step just taken, when the provider returns it. Display-only
    /// (a `thinking` block) — never committed to the durable history.
    Thinking(String),
    /// A named artifact was just saved/edited (`save_artifact`/`edit_artifact`). Lets a front-end
    /// react — e.g. the desktop app refreshes the live `todos` view.
    Artifact { name: String },
    /// The model asked the user structured questions (`ask_user`) — the turn ends right after this
    /// event; answers arrive as the next user message. Desktop renders clickable options; the TUI
    /// renders a numbered block.
    AskUser { questions: Vec<AskQuestion> },
    /// A lifecycle note (job update, context compacted, hit the cap, …).
    Note(String),
    /// The turn exhausted its step budget with work possibly unfinished — a gate, not a wall: the
    /// UI offers a one-key continue (history is intact, so a fresh turn resumes cleanly).
    StepLimit(usize),
    /// A hard error ended the turn.
    Error(String),
    /// The turn finished (natural completion or clean stop).
    Done,
}
