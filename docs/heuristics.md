# SPEAR decision heuristics

The decision tree Agent J runs each task through. This is the reference version; the operational
encoding lives in `agentj-rs/src/prompt.rs` (doctrine the model reads) and `agentj-rs/src/agent.rs`
(supervisor gates that enforce the load-bearing nodes). Tags: **[gate]** = supervisor-enforced,
**[doctrine]** = prompt, **[tool]** = tool-level behavior.

## The four generating invariants

Every rule below derives from these; when a situation isn't covered, derive from first principles:

1. **Delegate the reading, never the deciding.** Subagents scout, enumerate, draft, and verify;
   the primary agent adjudicates. Decomposition is low-read/high-judgment work that belongs in the
   context with the most accumulated understanding.
2. **Ceremony scales with uncertainty, not task size.** No frontier for one wave, no design doc for
   a settled shape, no scout for a two-grep probe.
3. **Evidence must match the kind of work.** A unit test proves logic; only the running system
   proves a service; only a rendered page proves UI.
4. **Nothing outward before it's real.** The right branch before any edit; a push before any review
   thread is resolved, comment posted, or issue closed. The same rule guards both ends of the
   pipeline.

## Phase 0 — entry

```
prompt arrives
├─ skill index has a match? ───────── read its SKILL.md FIRST; it shapes everything  [doctrine]
├─ fresh session + frontier on disk? ─ supervisor injects .aj/task/plan.md; resume,
│                                       don't re-scope                               [gate]
├─ non-repo question? ─────────────── answer directly; SPEAR collapses to Resolve
└─ else ───────────────────────────── SCOPE
```

## Scope

```
FLOOR (never skipped):
├─ named PR/branch and not on it → checkout; can't cleanly? STOP, report git state   [doctrine, hard]
└─ identify task kind from HARD evidence — never assumption                          [doctrine]

EXPLORATION (depth = locus uncertainty):
├─ evidence in hand ──────────────── done; go to PLAN
├─ a few greps away ──────────────── probe INLINE (this reading feeds your judgment)
├─ SCOUT test — delegate the probe iff ANY:                                          [doctrine]
│    · enumeration spans many files / an unfamiliar subsystem
│    · read-to-report ratio is high
│    · ≥2 independent angles (one scout each, ONE delegate call)
│    └─ scouts return a DRAFT brief/work-list — never changes
└─ bug with no repro ─────────────── the repro IS the scope work; repro before theory [doctrine]

EXIT: task kind + evidence + files stated; open questions recorded as assumptions    [doctrine]
```

## Meta-plan — the frontier decision (re-asked at every join)

```
does remaining work outlive ONE wave?
├─ NO ── the delegate call's `tasks` array IS the meta-plan; no file
└─ YES ─ write/update .aj/task/plan.md (pending / done / evidence)                   [doctrine]
          triggers: work-list > one wave · open hypotheses · a subagent's
          `frontier:` line · the step budget will end the turn first
AUTHORSHIP: the parent owns the frontier; a scout may draft it                       [doctrine]
MECHANICS: .aj/ self-ignores from git [tool]; a surviving frontier is injected
           on the first turn of the next session [gate]
```

## Plan

```
can you name the exact files AND is the design settled?                              [doctrine gate]
├─ files NOT nameable ────────── back to SCOPE (usually the scout branch)
├─ nameable, design OPEN ─────── the design IS the task: write it before ANY edit
│   ├─ ask leaves shape open ─── surface options; proceed on a stated assumption
│   └─ contested + costly redo ─ N competing drafts in ONE delegate call; adjudicate [doctrine]
└─ BOTH settled ── decompose:
    ├─ ≥2 independent, read-heavy sub-tasks ── ONE wave, DISJOINT file sets          [doctrine]
    └─ small / interdependent ─────────────── direct execution, no planning theater
```

## Execute

```
├─ several fixes, one file ───── one edit_file call (`edits` array)                  [doctrine]
├─ several independent files ─── ALL the calls in ONE response (rendered `+`)        [doctrine]
├─ scratch iteration ─────────── rewrite wholesale with write_file                   [doctrine]
├─ old_string not found ──────── repair from the nearest-match echo; ONE resend      [tool]
├─ long command ──────────────── job_start; keep working                             [doctrine]
└─ sprawl check ─ fanning into independent threads? stop, update frontier, delegate
                  (backstopped by the SPEAR checkpoint at 12 direct calls)           [gate]
```

## Assess

```
evidence must fit the KIND of work:                                                  [doctrine]
├─ pure logic / library ── test suite
├─ script ──────────────── run it, show output
├─ service/API ─────────── runtime proof against the BOOTED system; unit tests
│                           insufficient; impossible? say so + name what WOULD prove it
└─ frontend ────────────── web_check / e2e on the dev server

independent, expensive lenses (suite, typecheck, runtime probe) → ONE parallel wave;
each returns verdict + failing lines only                                            [doctrine]
backstop: a turn cannot end with unverified edits — one nudge                        [gate]
```

## Resolve

```
├─ question ── evidence-backed answer; CHECKED separated from ASSUMED                [doctrine]
└─ change:
    ├─ stage EXACTLY the deliberate files (never add -A)                             [doctrine]
    ├─ commit → push → PR → checks pass                                              [doctrine]
    │   ├─ committed, tree dirty ── one nudge listing stragglers                     [gate]
    │   └─ edited, ZERO commits ── one nudge: ship or state why unshipped            [gate]
    ├─ outward actions ONLY AFTER the push                                           [doctrine + gates]
    └─ promote residues, then let scratch die:                                       [doctrine]
        design → PR description · conventions → AGENTS.md · unfinished frontier →
        the "what's left" of the report
```
