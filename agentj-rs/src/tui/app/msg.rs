//! Messages into the UI event loop ([`UiMsg`]), the deferred work it hands back out ([`AppEffect`]),
//! and the handle to a running turn ([`TurnHandle`]).

use super::ProviderSetup;
use crate::events::AgentEvent;
use crate::mcp::client::McpStatus;
use crate::model::{Provider, SelectorOverride};
use crate::provider::ChatMessage;
use crate::rekey::RekeyResult;
use tokio::task::AbortHandle;

/// Messages from the turn task into the UI event loop.
pub enum UiMsg {
    Agent(AgentEvent),
    /// Newly committed history — an assistant reply, a tool-call group, or a nudge — appended as the
    /// turn progresses so an interrupt keeps whatever already applied.
    HistoryDelta(Vec<ChatMessage>),
    /// The turn task finished (natural completion or clean stop).
    TurnDone,
    /// A `/task` re-key finished off-thread; carries its result and the task directive to start.
    RekeyDone {
        rk: RekeyResult,
        desc: String,
    },
    /// An `/mcp login` flow finished; on success the loop reconnects MCP and rebuilds the session.
    McpAuthDone {
        name: String,
        result: Result<(), String>,
    },
    /// A background MCP reconnect finished — the loop swaps these into a fresh `Session`.
    McpReconnected {
        clients: crate::mcp::client::McpClients,
        statuses: Vec<McpStatus>,
    },
}

/// A running turn: its abort handle plus the job-id watermark captured at spawn, so an interrupt can
/// kill exactly the background jobs this turn started.
pub struct TurnHandle {
    pub abort: AbortHandle,
    pub job_watermark: u64,
}

/// Work the event loop must perform after a state transition (it needs `.await` or the turn task's
/// handles, which `App` doesn't own).
pub enum AppEffect {
    None,
    Quit,
    /// Switch the active provider/model for future turns.
    SwitchModel {
        provider: Provider,
        selector: SelectorOverride,
    },
    /// Spawn a turn from the current committed history; the loop stores the handle in `App::turn`.
    SpawnTurn,
    /// Run a `/task` re-key, then feed the result back via `apply_rekey_result`.
    Rekey {
        reference: String,
        desc: String,
    },
    /// SIGKILL background jobs started at or after this watermark (an interrupted turn's jobs).
    KillJobsAfter(u64),
    /// `/init`: write boilerplate config, then start the orchestrated mapping turn.
    Init,
    /// `/knowledge`: diff the tree against the knowledge index, then start a doc-sync turn.
    Knowledge,
    /// A snapshot-tracked turn finished cleanly — rebuild the knowledge index.
    Snapshot,
    /// First-run setup: persist a provider to the global config and build a live client from it.
    ConfigureProvider(ProviderSetup),
    /// Copy this text to the system clipboard (emitted via OSC 52 by the event loop).
    Copy(String),
    /// `/mcp login <name>`: run the one-time OAuth flow for that server, then reconnect.
    McpLogin(String),
    /// `/mcp logout <name>`: drop the server's cached grant.
    McpLogout(String),
}
