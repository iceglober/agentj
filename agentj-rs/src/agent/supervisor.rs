//! The supervisor: turn-level gates and nudges layered on the model loop. It watches the turn's
//! tool traffic (edits, checks, commits, sprawl) and injects one-shot course-corrections as
//! user-role messages — advisory pressure on the model, never control flow. Every nudge fires at
//! most once per turn.

use super::Session;
use serde_json::Value;

/// Direct (non-delegate) tool calls in one turn before the single SPEAR re-anchor nudge fires. The
/// prompt's own heuristic is "delegate what you can't name the files for" — this is the backstop
/// when execution sprawls anyway. Advisory, once per turn; primary loop only. Set high (12): at a
/// dozen calls the agent is usually legitimately deep in one focused change, and an earlier nudge
/// was observed to push wasteful delegation whose subagents re-derive the parent's context.
const SPEAR_NUDGE_AFTER: usize = 12;

/// One turn's gate state. `run_turn` reports every executed tool call through [`observe_call`];
/// the nudge methods consult the accumulated state and return the supervisor message to inject,
/// marking themselves spent so they can't repeat.
///
/// [`observe_call`]: Supervisor::observe_call
pub(super) struct Supervisor {
    /// Subagents get a reduced rule set: SPEAR and the ship/dirty-tree gates are primary-loop
    /// concerns (a subagent's result is consumed by its parent, not shipped).
    primary: bool,
    /// Non-delegate tool calls so far this turn.
    direct_calls: usize,
    used_delegate: bool,
    spear_nudged: bool,
    /// A write/edit landed with no passing check after it — arms the ASSESS gate.
    edited_since_check: bool,
    /// Any write/edit has landed — the turn is past exploration.
    mutated_this_turn: bool,
    assess_nudged: bool,
    committed_this_turn: bool,
    commit_nudged: bool,
    ship_nudged: bool,
}

impl Supervisor {
    pub(super) fn new(primary: bool) -> Self {
        Self {
            primary,
            direct_calls: 0,
            used_delegate: false,
            spear_nudged: false,
            edited_since_check: false,
            mutated_this_turn: false,
            assess_nudged: false,
            committed_this_turn: false,
            commit_nudged: false,
            ship_nudged: false,
        }
    }

    /// Any write/edit has landed — compaction may start aging out older reads.
    pub(super) fn mutated(&self) -> bool {
        self.mutated_this_turn
    }

    /// Step-budget awareness: with ~8 steps left, tell the model to converge instead of letting
    /// it burn its last calls mid-flail (observed: a run spent its final 20 steps on one-line
    /// edits and hit the wall with no report). Skipped for tiny budgets where it would fire
    /// immediately.
    pub(super) fn step_budget_nudge(step: usize, max_steps: usize) -> Option<String> {
        if max_steps > 16 && step + 8 == max_steps {
            Some(format!(
                "[supervisor: step budget — 8 of {max_steps} steps remain in this turn. Converge now: batch \
                 any remaining edits into one call, run the single most decisive check, ship what's \
                 done (commit, push), and write your report. Never take outward actions for \
                 unshipped work — resolving review threads or posting comments that claim a fix \
                 comes AFTER the push. If work will remain, end with exactly what's left and how to \
                 continue.]"
            ))
        } else {
            None
        }
    }

    /// SPEAR re-anchor: once per turn, if direct execution has run long with no delegation, remind
    /// the model to check its trajectory against PLAN. Advisory — the model decides what to do.
    pub(super) fn spear_nudge(&mut self) -> Option<String> {
        if !self.primary
            || self.spear_nudged
            || self.used_delegate
            || self.direct_calls < SPEAR_NUDGE_AFTER
        {
            return None;
        }
        self.spear_nudged = true;
        let direct_calls = self.direct_calls;
        // Design-aware: if the model is STILL exploring (no edit yet) after this many calls, the
        // risk isn't slowness — it's diving in before the design is settled. Push it to write the
        // design first. Only once it's already editing does "keep going / delegate if sprawling"
        // become the right reminder.
        Some(if self.mutated_this_turn {
            format!(
                "[supervisor: SPEAR checkpoint — {direct_calls} tool calls into this turn. If you're \
                 making steady progress on a well-scoped change, keep going — no need to change \
                 course. Only if you've been exploring without converging, or the work has fanned \
                 out into several INDEPENDENT threads, consider handing the rest to `delegate` to \
                 keep your context focused.]"
            )
        } else {
            format!(
                "[supervisor: SPEAR checkpoint — {direct_calls} tool calls in and no edits yet, so \
                 you're still in SCOPE/PLAN. Before your first edit, settle the DESIGN: if this \
                 introduces or reshapes an abstraction, data model, config schema, interface, or \
                 precedence rule, write that design out now — data model, order/precedence, edge \
                 cases, back-compat — rather than discovering the shape mid-edit. If the shape is \
                 already obvious and the change is well-scoped, go ahead.]"
            )
        })
    }

    /// Gate bookkeeping for one executed tool call: edits arm the ASSESS gate; a passing check (or
    /// a passing `web_check`, which IS frontend verification) clears it; a successful `git commit`
    /// arms the RESOLVE completeness gate.
    pub(super) fn observe_call(
        &mut self,
        name: &str,
        is_delegate: bool,
        args: &Value,
        result_text: &str,
        ok: bool,
        configured_check: Option<&str>,
    ) {
        if is_delegate {
            self.used_delegate = true;
            return;
        }
        self.direct_calls += 1;
        match name {
            "write_file" | "edit_file" | "edit_lines" if ok => {
                self.edited_since_check = true;
                self.mutated_this_turn = true;
            }
            "web_check" if ok => self.edited_since_check = false,
            "bash" => {
                if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                    if is_check_command(cmd, configured_check) && result_text.contains("[exit 0]") {
                        self.edited_since_check = false;
                    }
                    // `git -c user=… commit`, `git commit -m`, etc. — any git invocation
                    // with a `commit` word arms the completeness gate.
                    let is_commit =
                        cmd.contains("git") && cmd.split_whitespace().any(|w| w == "commit");
                    if is_commit && result_text.contains("[exit 0]") {
                        self.committed_this_turn = true;
                    }
                }
            }
            _ => {}
        }
    }

    /// The finishing gates, consulted when the model goes idle (a reply with no tool calls).
    /// Returns the first nudge that fires — the turn continues so the model can act on it —
    /// or `None` when the turn is clear to end.
    pub(super) async fn finishing_nudge(&mut self, sess: &Session) -> Option<String> {
        // ASSESS gate: edits landed but no project check has PASSED since the last one — one
        // supervisor nudge before the turn may end. The agent verifies without being asked.
        if self.edited_since_check && !self.assess_nudged {
            self.assess_nudged = true;
            let hint = sess
                .cfg
                .check
                .as_deref()
                .map(|c| format!(" (`{c}`)"))
                .unwrap_or_default();
            return Some(format!(
                "[supervisor: ASSESS check — you edited files this turn but no project check has \
                 passed since the last edit. Run the project's checks{hint} and show the result \
                 before finishing. If you changed live service/API behavior, tests alone aren't \
                 proof — boot the system (AGENTS.md/dev scripts, `job_start`) and exercise the \
                 changed path for real, or state explicitly why that's impossible here. If a check \
                 genuinely doesn't apply, say why in your final report.]"
            ));
        }

        // RESOLVE ship gate (primary loop): edits landed but NOTHING was committed — the change
        // exists only in this worktree. Observed live: a turn "finished" by resolving PR review
        // threads on GitHub while the fix sat unpushed. One nudge, and only inside a git repo
        // (nothing to ship otherwise).
        if self.primary && self.mutated_this_turn && !self.committed_this_turn && !self.ship_nudged
        {
            self.ship_nudged = true;
            let root = sess.tools.root.to_string_lossy().to_string();
            let in_repo =
                crate::exec::run(&["git", "rev-parse", "--is-inside-work-tree"], &root, None)
                    .await
                    .is_ok_and(|o| o.exit_code == 0);
            if in_repo {
                return Some(
                    "[supervisor: RESOLVE ship check — you edited files this turn but \
                     committed nothing, so the change exists only in this worktree. RESOLVE \
                     means SHIP: stage exactly the files you changed, commit, push, and update \
                     the PR — or state explicitly in your final report that the change is \
                     intentionally unshipped and why. Either way, do NOT take outward actions \
                     that tell humans it's done (resolving review threads, posting PR comments, \
                     closing issues) until the change is pushed.]"
                        .to_string(),
                );
            }
        }

        // RESOLVE gate (primary loop): a commit happened but the tree is still dirty — the
        // half-shipped-change failure mode. One nudge listing the stragglers.
        if self.primary && self.committed_this_turn && !self.commit_nudged {
            self.commit_nudged = true;
            let root = sess.tools.root.to_string_lossy().to_string();
            if let Ok(o) = crate::exec::run(&["git", "status", "--porcelain"], &root, None).await {
                let dirty: Vec<&str> = o.stdout.lines().filter(|l| !l.is_empty()).take(15).collect();
                if o.exit_code == 0 && !dirty.is_empty() {
                    return Some(format!(
                        "[supervisor: RESOLVE check — you committed this turn, but the working tree \
                         still has uncommitted changes:\n{}\nCommit what belongs with your change, \
                         or explain in your final report why these are excluded.]",
                        dirty.join("\n")
                    ));
                }
            }
        }
        None
    }
}

/// Frontier resume: a prior session's task frontier survives on disk (`.aj/task/plan.md`). On the
/// first turn of a fresh session the supervisor embeds it, so the model resumes from the plan
/// instead of re-deriving scope.
pub(super) fn frontier_nudge(sess: &Session) -> Option<String> {
    let f = std::fs::read_to_string(sess.tools.root.join(".aj/task/plan.md")).ok()?;
    let f = f.trim();
    if f.is_empty() {
        return None;
    }
    let capped: String = f.chars().take(4000).collect();
    Some(format!(
        "[supervisor: a task frontier from a previous session exists (.aj/task/plan.md):\n\
         {capped}\n\
         If this task continues it, resume from the plan — don't re-derive scope. If it's \
         a different task, overwrite the file when you write your next frontier.]"
    ))
}

/// True when a bash command looks like it runs the project's checks. The configured `check` command
/// wins; otherwise a conservative list of common test/build invocations.
pub(super) fn is_check_command(cmd: &str, configured: Option<&str>) -> bool {
    if let Some(c) = configured {
        let c = c.trim();
        if !c.is_empty() && cmd.contains(c) {
            return true;
        }
    }
    const HINTS: [&str; 17] = [
        "cargo test", "cargo check", "cargo clippy", "pytest", "go test", "bun test", "npm test",
        "pnpm test", "pnpm -r test", "vitest", "make test", "make check",
        // end-to-end / browser runners — how frontend work is actually verified
        "playwright", "cypress", "test:e2e", "run e2e", "webdriver",
    ];
    HINTS.iter().any(|h| cmd.contains(h))
}
