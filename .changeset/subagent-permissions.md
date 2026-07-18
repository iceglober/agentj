---
"@glrs-dev/aj": minor
---

Subagent and background-job tool calls now answer to the session permission gate: build-mode `run_subagents` children and `&`-job delegates previously ran bash on the host with no prompts (worktree isolation only confines their edits). Their asks queue into the same modal, labeled with the requester (`Permission bash — subagent t2`, `job j1`), and session-wide "always" grants apply across parent and children. Non-interactive `run` applies its allow-all/deny policy to children too.
