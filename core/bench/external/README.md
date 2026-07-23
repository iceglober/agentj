# External coding-agent benchmark

This pilot runs Glorious, Codex, Claude Code (Opus 4.7 and Fable 5), and OpenCode
on five pinned SWE-bench Verified tasks. Each run receives the same issue text
in a fresh checkout at the dataset's exact base commit. Raw output, patches,
timing, and native usage are retained under the selected benchmark root.

Before execution, the runner fetches current prices from
[models.dev](https://models.dev/) and prints a nominal matrix estimate using
23,029 input and 817 output tokens per run. This is a planning estimate; actual
cost is computed from each CLI's native usage because agent system prompts and
tool loops differ.

Preview the matrix:

```sh
bun core/bench/external/run.ts
```

Execute the pilot (default root: `/tmp/glorious-external-bench`):

```sh
bun core/bench/external/run.ts --run
```

Filter with `--arm glorious-luna,codex-sol` or `--task django__django-11179`.
Generated patches are intended for the official SWE-bench Docker evaluator;
the runner never applies gold patches or exposes benchmark hints to agents.

The first completed pilot and its low-versus-medium Glorious diagnostic are in
[`pilot-2026-07-21.md`](./pilot-2026-07-21.md).

Export official prediction files after a run:

```sh
bun core/bench/external/export-predictions.ts
```
