# Edit tool A/B benchmarks

Comparing edit-tool designs for the AI SDK agent loop (`core/ab-edit.ts` harness,
`gpt-5.6-sol` via Azure, microsandbox `python` image). Each run is a single prompt:
run the tests, fix the bugs via the edit tool only, re-run to green. The harness
grades independently (restores `tests.py`, re-runs it), flags shell-redirection
writes to source files, and reports whole-run metrics — token counts and wall
times include failed edits and their reconciliation round-trips.

## Variants (`edit-tools.ts`)

- **default** — exact `old_string`/`new_string` replacement, one edit per call;
  must match exactly once (Claude Code-style).
- **batched** — same matching rules, but an array of edits applied atomically in
  one call; any failure aborts the whole call with nothing written.
- **hashline** — `readFile` prefixes every line with an anchor `LINE#HASH|`;
  edits target anchors (replace / insert_after / delete, ranges via `end_anchor`),
  applied atomically. Stale anchors (file changed since read) reject the call.

## Round 1 — single file, 3 bugs (default vs hashline, n=8 each)

~45-line `calc.py`, 3 bugs, one on a line duplicated verbatim elsewhere.
Data: `core/ab-edit-results.json` (commit `b21a28d`).

| avg, n=8 | default | hashline |
|---|---|---|
| passes | 8/8 | 8/8 |
| total tokens | 13,086 | 9,446 |
| steps | 8.0 | 6.0 |
| edit calls | 3.5 | 1.0 |
| edit errors | 0 | 0 |
| median wall | 15.4s | 14.2s |

Hashline won on tokens (−28%), but all of its advantage came from batching all
fixes into one call — which motivated the batched control in round 2.

## Round 2 — multi-file, 8 bugs (all three variants, n=6 each)

4-file package (`utils/models/pricing/cart.py`, ~180 lines) + tests. Traps:
`return price * (1 - rate)` appears verbatim in three functions (one correct,
two buggy) with near-identical surrounding lines; a cross-file rename
(`fmt_money` vs `format_money`); three boundary/off-by-one bugs. Fixture
validated by `--selfcheck` (buggy fails 9 checks, reference fix passes).
Data: `core/ab-edit-results-v2.json` (commit `fbbcbd3`).

| avg, n=6 | default | batched | hashline |
|---|---|---|---|
| passes | 6/6 | 6/6 | 6/6 |
| total tokens | 47,357 | **19,607** | 25,128 |
| input tokens | 45,508 | **18,336** | 24,137 |
| output tokens | 1,849 | 1,272 | **991** |
| steps | 12.0 | 7.3 | 7.3 |
| edit calls | 10.3 | 4.5 | **4.0** |
| edit errors (total) | 4 | 3 | **0** |
| median wall | 42.3s | **18.6s** | 20.1s |

## Findings

- **Batching is the dominant factor, not the anchor mechanism.** One edit call
  per file instead of one per fix cut default's tokens by ~58%; hashline's v1
  win was mostly this in disguise.
- **String matching pays an input-token tax under drift and duplication.**
  Default needed ~10 round-trips on growing context; the triplicated line caused
  4 uniqueness failures across default runs (worst run: 76k tokens, 3 errors).
- **Hashline pays a read tax instead.** Anchor prefixes on every read plus
  stale-anchor re-reads after each edit (9.3 reads/run vs batched's 6.3) put it
  ~24% above batched on input tokens, with wider variance (16.8k–38.7k).
- **Hashline is the only variant with zero edit errors — 24/24 runs across both
  rounds.** It also emits the fewest output tokens (anchors are cheaper to write
  than duplicated `old_string` context) — relevant where output pricing or
  generation latency dominates.
- **Correctness never separated the variants** at this difficulty; every failed
  edit was recovered within the step budget. Nobody cheated via redirection.

## Recommendation

Batched exact-replace captures most of the win and is the simpler design.
Hashline's remaining edge is robustness under repeated edits to drifting files;
revisit it if match-failure loops show up in long-horizon runs, where a failed
match costs far more than it did here. Untested regime: files changing between
read and edit (compaction, concurrent writes) — exactly where stale-anchor
detection should shine; a v3 would stress that.

## Reproducing

```sh
bun core/ab-edit.ts --selfcheck          # validate fixture
bun core/ab-edit.ts --repeat 6           # all variants, interleaved
bun core/ab-edit.ts --repeat 8 --variant hashline
```

Requires `AZURE_FOUNDRY_API_KEY` (e.g. via `core/.env`, sourced manually —
tsx/bun don't auto-load it from a subdirectory).
