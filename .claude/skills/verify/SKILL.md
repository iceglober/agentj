---
name: verify
description: Drive the glorious TUI end-to-end and capture what it paints — build/launch/drive recipe for verifying chat and progress-rendering changes at the real terminal surface.
---

# Verifying glorious at the TUI surface

## Launch

- Headless smoke test (key resolution + model access, no TUI):
  `cd <some-git-repo> && bun <repo>/core/agent-loop.ts run --plan --allow-all "Say the single word: ready"`
- Interactive chat: `bun <repo>/core/agent-loop.ts` from inside any git repo (needs the Azure key in the keyring; works from the sandbox).
- Make a throwaway target repo in the scratchpad (`git init` + a couple of files) so chat sessions don't pollute a real project.

## Drive it (no tmux on this machine; screen's hardcopy writes empty files)

Use `/usr/bin/expect` with a stream log. Two gotchas, both fatal:

- expect's `sleep` does not read the pty — output stalls and nothing is logged. Pump instead:
  `proc pump {secs} { expect -timeout $secs -re {ZZZ_NEVER_MATCHES_ZZZ} }`
- Under a non-tty parent the spawned pty is 0×0 and the live region (editor, progress block, status bar) is never painted. After `spawn`:
  `stty rows 50 columns 200 < $spawn_out(slave,name)`

Keys: `\r` submits, `\x1b` (Esc) interrupts the turn, `\x03` (Ctrl-C) once aborts / twice quits. Default mode is plan; Tab toggles.

A prompt like "call run_subagents with exactly 3 tasks - t1: …; t2: …; t3 (waitsOn t1 and t2): …" reliably triggers a fan-out in plan mode (~10s, small token cost).

## Read the capture

Strip ANSI: `perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g; s/\e\][^\a]*\a//g; s/\r//g'`.
The cleaned stream is a time-series of live-region repaints; transcript lines (`printAbove`) appear once in write order. Grep anchors: `⏵` (status bar), `✓ run_subagents` (frozen tool row), spinner glyphs `◐◓◑◒` (live rows).
