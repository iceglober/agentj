# Edit tool A/B benchmarks

Harness: `ab-edit.ts` (this directory). Model: `gpt-5.6-sol` (Azure). Sandbox: microsandbox
`python` image. One prompt per run: run tests, fix bugs via the edit tool only,
re-run to green. Grading: harness restores `tests.py` and re-runs it after the
agent finishes. Token counts and wall times cover the whole `generate()` call,
including failed edit calls and their retries. Runs interleaved across variants.

## Variants (`../{exact,batch,hash}-edit.ts`; registry: `../index.ts`)

- `exact` — exact `old_string`/`new_string` replacement, one edit per call,
  must match exactly once unless `replace_all`.
- `batch` — same matching rules; array of edits applied atomically in one
  call; any failure aborts the call with nothing written.
- `hash` — `readFile` prefixes every line with `LINE#HASH|`; edits target
  anchors (`replace` / `insert_after` / `delete`, ranges via `end_anchor`),
  applied atomically; stale anchors reject the call.

Result JSONs predate the mode names: `default` = `exact`, `batched` = `batch`,
`hashline` = `hash`.

## Round 1 — single file, 3 bugs (n=8 per variant)

Fixture: ~45-line `calc.py`, 3 bugs, one on a line duplicated verbatim
elsewhere. Per-run data: `ab-edit-results.json` (commit `b21a28d`).

| avg, n=8     | default | hashline |
| ------------ | ------- | -------- |
| passes       | 8/8     | 8/8      |
| total tokens | 13,086  | 9,446    |
| input tokens | 12,419  | 9,029    |
| output tokens| 667     | 417      |
| steps        | 8.0     | 6.0      |
| edit calls   | 3.5     | 1.0      |
| edit errors  | 0       | 0        |
| median wall  | 15.4s   | 14.2s    |

## Round 2 — multi-file, 8 bugs (n=6 per variant)

Fixture: 4-file package (`utils/models/pricing/cart.py`, ~180 lines) + tests;
8 bugs; `return price * (1 - rate)` appears verbatim in three functions (one
correct, two buggy); cross-file rename (`fmt_money` vs `format_money`); three
boundary/off-by-one bugs. Fixture validated by `--selfcheck` (buggy fails 9
checks, reference fix passes). Per-run data: `ab-edit-results-v2.json`
(commit `fbbcbd3`).

| avg, n=6            | default | batched | hashline |
| ------------------- | ------- | ------- | -------- |
| passes              | 6/6     | 6/6     | 6/6      |
| total tokens        | 47,357  | 19,607  | 25,128   |
| input tokens        | 45,508  | 18,336  | 24,137   |
| output tokens       | 1,849   | 1,272   | 991      |
| steps               | 12.0    | 7.3     | 7.3      |
| edit calls          | 10.3    | 4.5     | 4.0      |
| edit errors (total) | 4       | 3       | 0        |
| readFile calls      | 8.8     | 6.3     | 9.3      |
| median wall         | 42.3s   | 18.6s   | 20.1s    |

Total-token range per run: default 34,140–75,977; batched 14,828–26,036;
hashline 16,838–38,708. Redirection-cheat flags: 0 in all 36 runs.

## Reproducing

```sh
bun core/lib/tools/edit/benchmarks/ab-edit.ts --selfcheck          # validate fixture
bun core/lib/tools/edit/benchmarks/ab-edit.ts --repeat 6           # all variants, interleaved
bun core/lib/tools/edit/benchmarks/ab-edit.ts --repeat 8 --variant hash
```

Requires `AZURE_FOUNDRY_API_KEY` in the environment (e.g. `core/.env`, sourced
manually).
