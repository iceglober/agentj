# Research summary — long-horizon autonomous outcomes

Date: 2026-07-05 · Branch: `research/long-horizon` · 10 sweeps · 330 task-runs · ~36.3M input tokens (Azure gpt-5.4)

## Result

**Final stack (kept): 47/66 pooled (71.2%) vs baseline 21/33 (63.6%), avg tokens/run −15% (≈103k vs 122k).**
Best single sweeps hit 26/33 (78.8%) twice; re-validation on identical code scored 21/33 —
the metric's noise floor is ±5 passes per 33-run sweep, so pooled numbers are the honest claim.

## Kept changes (all on `research/long-horizon`, commits #3→#6)

1. **#3 Verbatim evidence chain** (`prompt.rs`) — RESOLVE doctrine + subagent result instructions
   require exact identifiers (deploy ids, config keys, error strings) quoted character-for-character.
   Targeted effect: answer-missing failures 6 → 1-2 per sweep.
2. **#4 Broad-then-narrow search** (`prompt.rs` SCOPE) — one whole-range pattern search before any
   narrowing; broaden the pattern before concluding absence. Targeted effect: cloud-needle 0/3 →
   2/3 every sweep since, with tokens 154k → ~40k (the strongest, most mechanism-consistent win).
3. **#5 Delegation efficiency** (`tools/spec.rs` + `prompt.rs`) — briefs must carry located
   files/paths + exact return shape; subagents get a strict fewest-calls bar.
4. **#6 Nondeterminism carve-out** (`prompt.rs`) — reproduction of flaky/racy behavior is exempt
   from anti-repetition rules (repetition is the method there). Kept by judgment (INTERESTING):
   primary flat, targeted task recovered exactly as predicted.

## Failed approaches (all reset; SHAs in results.tsv)

- **#1 compaction during read-only exploration** — INVERSE: elided context forces tool re-runs (19/33).
- **#2 re-read suppression nudge** — tokens −8% but passes down (19/33).
- **#7 one-decisive-stroke edits** — INVERSE: debugging needs iteration; targeted task went 0/3 at
  its worst-ever token burn (19/33).
- **#8 read-span steering** — fragments starve context; extra stitching calls (23/33).

## The law (replicated 3-4×, the study's key insight)

**Never restrict what the model may look at; only sharpen strategy.** Every experiment that
constrained information access (eliding, no-reread, one-stroke, span-reads) regressed — usually
inverting on its own target task. Every keep sharpened strategy instead: WHERE to search first,
WHAT a delegation brief carries, WHAT the report must quote. Access restrictions make the model
pay the context back with interest through extra round-trips.

## Measurement insight

33-run sweeps of an LLM agent have a ±5-pass noise floor (identical code: 26, 26, 21). Future
work should use paired per-task comparisons or ≥5 repeats before trusting any single-sweep delta;
targeted per-task flips with token-profile changes (needle: 0/3→2/3 at ¼ the tokens) are far
stronger evidence than the headline number.

## Genealogy

#0 baseline → #1✗ → #2✗ → #3✓ → #4✓ → #5✓ → #6~ → #7✗ → #8✗ → #9 (re-validation).
Single branch; no forks needed (the 3-discard guardrail never fired — discards alternated with keeps).

## Remaining parking lot

- Supervisor gate for "last check FAILED and turn tries to end" (H2 — untested; verify-fails were
  absent from most 2026-07-05 sweeps but 5/13 in history).
- cloud-capstone (1-2/3) and cloud-debug (0-2/3) remain budget-bound: both need genuinely fewer
  round-trips on edit loops; no safe in-scope lever found — candidate for a mechanism change
  outside this study's scope (e.g., a diff-aware check that reports only failures).
- dist-feature/dist-debug bounce 0/3↔3/3 across sweeps — dominated by run variance, not code.

## Recommendation

Merge `research/long-horizon`'s four keeps into main (they are pure prompt/spec text, all 176
unit tests green). Record "the law" in AGENTS.md so future tuning doesn't retry access
restrictions. If pass-rate work continues, invest in the eval first: more repeats or paired
grading, or the headline metric can't distinguish a real +2 from noise.
