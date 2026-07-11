---
name: tickets
description: >-
  Playbook for ticket-driven requests ("finish TICK-…", "work on TICK-…"):
  fetch the ticket from the tickets MCP server and verify its acceptance
  criteria against the repository BEFORE writing any code.
---

# Working a ticket (TICK-…)

The tracker is connected as the `tickets` MCP server.

1. **Fetch the ticket first.** Call `get_issue` with the ticket id to get its description and
   acceptance criteria. Never work from the id alone.
2. **Pre-flight.** Call `list_issues` to check for duplicates or related work in flight.
3. **Verify before coding.** The feature may already exist. Compare EACH acceptance criterion
   against the repository — read the relevant source and its tests, and check git history
   (`git log --oneline`) for prior work on this ticket.
4. **Only code a demonstrated gap.** If every criterion is already satisfied, do NOT change
   anything — re-implementing landed work churns the diff and invites regressions.
5. **Run runnable criteria yourself.** If a criterion is a command (a dry-run, a script, a
   check), RUN it and include its output in your report — a command handed back to the user
   to paste is an unfinished ticket.
6. **Report per criterion.** For each acceptance criterion: met or not, with evidence
   (path + the exported symbol or test that proves it, or the command output). If nothing is
   left to do, say so and name what non-code steps remain (e.g. moving the ticket's status).
