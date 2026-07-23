# Quickstart

After [installing](/install), open any git repo:

```bash
cd your-project
opencode
```

The [harness](/harness) loads automatically. You're talking to the [`prime`](/harness/agents) agent.

## Start a task

From a ticket:

```
/fresh ENG-1234
```

From a description:

```
/fresh add rate limiting to the upload endpoint
```

Or just ask:

```
fix the null pointer in UserService.getProfile
```

[`/fresh`](/harness/commands) creates a branch, scopes the work, and starts the [SPEAR](https://www.edge.ceo/p/introducing-spear-the-management) workflow.

## Ship your work

```
/ship
```

Squashes commits, pushes, opens a PR. See [`/ship`](/harness/commands).

## Review a PR

```
/review 87
```

Read-only adversarial review. Delegates to [`@code-reviewer`](/harness/agents). See [`/review`](/harness/commands).

## Deep research

```
/research how does authentication work in this codebase?
```

Parallel subagents, synthesized findings with file:line references. See [`/research`](/harness/commands).

## Run hands-off

```bash
glrs loop "implement the auth middleware"
```

Stops on completion, budget limits, or kill switch (`.agent/autopilot-disable`). See [autopilot](/autopilot).

## Check costs

```
/costs
```

## All commands

| Command | What it does |
|---------|-------------|
| [`/fresh`](/harness/commands) | Branch from ticket or description, start PRIME |
| [`/ship`](/harness/commands) | Squash, push, open PR |
| [`/review`](/harness/commands) | Adversarial review (PR#, SHA, branch, or file) |
| [`/research`](/harness/commands) | Parallel codebase exploration |
| [`/init-deep`](/harness/commands) | Generate AGENTS.md files |
| [`/costs`](/harness/commands) | LLM spend totals |
| [`/dispatches`](/harness/commands) | Subagent dispatch history |
