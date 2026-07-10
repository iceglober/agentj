//! Typed subagents: each is a specialization for a kind of work, with a scoped toolset (leaner
//! context + guardrails). The primary loop is NOT one of these; a `run_subagents` task picks one of
//! these narrower specializations.
//!
//! Two things a type carries: its **identity** (a role framing, prepended to the shared subagent
//! prompt in `crate::prompt`) and its **tool allowlist** (which built-in tools it may see and call
//! — MCP tools always pass through). The default when a task omits a type is `Executor`, which
//! keeps the historical "full-tools subagent" behavior.

/// A subagent's kind. Ordered roughly by how much they touch: read-only investigators first, the
/// change-maker last.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentType {
    /// Read-only clarify pass. Runs FIRST: turns the request's ambiguities into sharp questions
    /// (or reports it's already clear). Short by contract — light reads only, no shell.
    Questioner,
    /// Read-only investigation / context-gathering. Answers a question with evidence.
    Scout,
    /// Read-only design / decomposition. Produces a plan or design, weighs alternatives.
    Planner,
    /// Adversarial verification of a diff / plan / answer. Read + run checks; no edits.
    Reviewer,
    /// Makes a targeted change on assigned files. The default; full working toolset.
    Executor,
}

/// Read-only built-ins available to every investigator type.
const READ_ONLY: &[&str] = &[
    "read_file", "list_dir", "glob", "grep", "mcp_find_tools", "job_check", "read_artifact",
    "read_skill",
];

impl AgentType {
    /// Parse the `type` field of a `run_subagents` task; unknown/absent → the default `Executor`.
    pub fn parse(s: Option<&str>) -> AgentType {
        match s.map(|x| x.trim().to_ascii_lowercase()).as_deref() {
            Some("questioner") | Some("question") => AgentType::Questioner,
            Some("scout") => AgentType::Scout,
            Some("planner") => AgentType::Planner,
            Some("reviewer") => AgentType::Reviewer,
            _ => AgentType::Executor,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AgentType::Questioner => "questioner",
            AgentType::Scout => "scout",
            AgentType::Planner => "planner",
            AgentType::Reviewer => "reviewer",
            AgentType::Executor => "executor",
        }
    }

    /// Whether this type may see/call the named BUILT-IN tool. MCP tools are handled separately
    /// (they always pass through). A read-only type is denied write/edit; the change-maker gets
    /// everything a subagent is ever allowed (never `run_subagents` — subagents don't re-fan-out).
    pub fn allows(self, tool: &str) -> bool {
        match self {
            AgentType::Executor => tool != "run_subagents",
            // Questioner is deliberately the tightest: light reads only, no shell — it asks, it
            // doesn't investigate. That keeps it SHORT, which is the whole point of running it first.
            AgentType::Questioner => READ_ONLY.contains(&tool),
            AgentType::Scout => READ_ONLY.contains(&tool) || tool == "bash",
            AgentType::Planner => READ_ONLY.contains(&tool) || tool == "bash",
            AgentType::Reviewer => {
                READ_ONLY.contains(&tool) || matches!(tool, "bash" | "job_start" | "job_stop")
            }
        }
    }

    /// The type's role identity — prepended to the shared subagent prompt.
    pub fn identity(self) -> &'static str {
        match self {
            AgentType::Questioner =>
                "You are a QUESTIONER subagent — you run FIRST, before any deeper scouting. Your job is \
                 to surface the GENUINE ambiguity in the request as the sharpest possible clarifying \
                 questions, fast. Think in 2–4 competing interpretations of what the user might mean, \
                 find the axis that separates them, and ask ONE focused, non-leading, discriminative \
                 question per real gap — missing audience, scope, platform, data shape, success \
                 criteria, or a wrong premise. Do NOT ask what the request or the repo already answers, \
                 and never ask about implementation trivia. Ground yourself with only the lightest read \
                 of the repo. If the request is already unambiguous, SAY SO and return no questions — \
                 never manufacture them to fill space.",
            AgentType::Scout =>
                "You are a SCOUT subagent. Your job is to FIND OUT, not to change anything: explore the \
                 code read-only and answer the exact question you were given with hard evidence. You do \
                 NOT edit files. Quote every load-bearing identifier — file:line, exact keys, error \
                 strings — VERBATIM; a paraphrase the main agent can't grep is worthless.",
            AgentType::Planner =>
                "You are a PLANNER subagent. You produce a DESIGN or a decomposition, never code: read to \
                 ground yourself, work out the shape (data model, interfaces, precedence, edge cases, \
                 back-compat), and weigh the alternatives. Return the plan and the tradeoffs you chose \
                 between; you do not write files.",
            AgentType::Reviewer =>
                "You are a REVIEWER subagent — adversarial. Your job is to find what is WRONG: read the \
                 diff/plan/answer and run the project's checks; you do NOT edit. Every finding must be \
                 REAL — reproduce it or cite it at file:line, no invented nits. Score the work against \
                 the rubric below and report exactly in its shape.",
            AgentType::Executor =>
                "You are an EXECUTOR subagent. You deliver a targeted CHANGE on the files you were assigned: \
                 make the edits, then verify with the project's own check on what you touched. Stay INSIDE \
                 your assigned files — no scope creep. Return the files you changed plus the check output; \
                 quote identifiers verbatim.",
        }
    }

    /// The exact output a type must return, when it has a fixed shape. The reviewer scores against a
    /// MECE rubric — four non-overlapping dimensions that together cover every way work can be wrong,
    /// so nothing is double-counted and nothing slips through. `None` for types whose output shape is
    /// dictated by the brief. Emitted as the `<rubric>` section of the subagent prompt.
    pub fn report_rubric(self) -> Option<&'static str> {
        match self {
            AgentType::Questioner => Some(
                "Return ONLY this. If the request is already clear enough to act on, return the single \
                 line `no open questions` — do not invent questions to fill the list. Otherwise return \
                 the 2–4 highest-value questions, worst-ambiguity first. For EACH: the question in one \
                 non-leading sentence; 2–4 candidate answers; and your RECOMMENDED default with a \
                 one-phrase why. No preamble, no meta-commentary — just the questions.",
            ),
            AgentType::Reviewer => Some(
                "Judge the work against these FOUR dimensions. They are mutually exclusive (a fault \
                 belongs to exactly one) and collectively exhaustive (together they cover every way \
                 the work can be wrong) — so assign each fault to one dimension and check that none \
                 is left unexamined:\n\
                 1. CORRECTNESS — does the logic do what it intends? wrong results, bad edge cases, \
                 off-by-one, unhandled errors, broken invariants.\n\
                 2. REQUIREMENTS — does it fulfill what was actually asked, in full? nothing missing, \
                 nothing built beyond the request.\n\
                 3. SAFETY — security holes, data loss, race conditions, resource leaks, unsafe \
                 defaults.\n\
                 4. MAINTAINABILITY — readability, naming, dead or duplicated code, and whether the \
                 change is covered by tests.\n\
                 For EACH dimension return PASS or FAIL with concrete evidence (file:line or a \
                 reproduction). Then give ONE overall verdict: SHIP or BLOCK. List the failing \
                 findings worst-first.",
            ),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_defaults_to_executor_and_reads_known_types() {
        assert_eq!(AgentType::parse(None), AgentType::Executor);
        assert_eq!(AgentType::parse(Some("weird")), AgentType::Executor);
        assert_eq!(AgentType::parse(Some(" Scout ")), AgentType::Scout);
        assert_eq!(AgentType::parse(Some("REVIEWER")), AgentType::Reviewer);
        assert_eq!(AgentType::parse(Some("planner")), AgentType::Planner);
        assert_eq!(AgentType::parse(Some("questioner")), AgentType::Questioner);
    }

    #[test]
    fn read_only_types_are_denied_writes_the_executor_is_not() {
        for ro in [AgentType::Scout, AgentType::Planner, AgentType::Reviewer, AgentType::Questioner] {
            assert!(!ro.allows("write_file"), "{ro:?} must not write");
            assert!(!ro.allows("edit_file"), "{ro:?} must not edit");
            assert!(ro.allows("read_file"), "{ro:?} can read");
        }
        // The questioner is tightest: it may read but not even shell out — it asks, it doesn't dig.
        assert!(!AgentType::Questioner.allows("bash"), "questioner stays short: no shell");
        assert!(AgentType::Scout.allows("bash"), "scout may shell out");
        assert!(AgentType::Questioner.report_rubric().is_some(), "questioner returns a fixed shape");
        // The executor gets the full subagent set, never the fan-out tool.
        assert!(AgentType::Executor.allows("write_file"));
        assert!(AgentType::Executor.allows("edit_file"));
        assert!(!AgentType::Executor.allows("run_subagents"));
        // A reviewer may run checks; a scout may not spawn long jobs.
        assert!(AgentType::Reviewer.allows("job_start"));
        assert!(!AgentType::Scout.allows("job_start"));
        // Only the reviewer carries a fixed output rubric.
        assert!(AgentType::Reviewer.report_rubric().is_some());
        assert!(AgentType::Scout.report_rubric().is_none());
        assert!(AgentType::Executor.report_rubric().is_none());
    }
}
