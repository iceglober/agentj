# Commands

7 slash commands available inside OpenCode. Type them in the chat input.

## /fresh

```
/fresh ENG-1234
/fresh add rate limiting to the upload endpoint
```

Creates a branch from a ticket reference or description, then starts the [SPEAR workflow](https://www.edge.ceo/p/introducing-spear-the-management) via the `prime` [agent](/harness/agents). If given a ticket ID, fetches context from your issue tracker.

## /ship

```
/ship
```

Squashes commits on the current branch, pushes to the remote, and opens a pull request with a structured description.

## /review

```
/review 87
/review feat/auth-middleware
/review abc1234
```

Read-only adversarial review. Accepts a PR number, branch name, or commit SHA. Fetches the diff, runs [typecheck and lint](/harness/tools), delegates to the [`code-reviewer`](/harness/agents) agent, and outputs a structured verdict.

## /research

```
/research how does authentication work in this codebase?
```

Spawns parallel subagents ([`research-web`](/harness/agents), [`research-local`](/harness/agents), [`research-auto`](/harness/agents)) that search the codebase from different angles, then synthesizes findings with exact `file:line` references.

## /init-deep

```
/init-deep
```

Generates hierarchical `AGENTS.md` files for directories in the codebase. Delegates to the [`agents-md-writer`](/harness/agents) agent.

## /costs

```
/costs
```

Shows cumulative LLM spend for the current session, broken down by provider and model. Data comes from the [cost-tracker sub-plugin](/harness).

## /dispatches

```
/dispatches
```

Shows subagent dispatch history — which agents were called, when, and their tier classification. Data comes from the [dispatch-tracker sub-plugin](/harness).
