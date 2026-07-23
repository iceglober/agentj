# Agents

29 agents. 4 user-selectable, the rest are subagents dispatched automatically.

## User-selectable

Pick these via Tab in OpenCode.

| Agent | Tier | Role |
|-------|------|------|
| `prime` | mid | [SPEAR](https://www.edge.ceo/p/introducing-spear-the-management) end-to-end workflow (default). Sonnet orchestrator — delegates planning to Opus and hard problems to @build-deep. |
| `prime-heavy` | deep | PRIME on Opus. Use when the task itself needs deep reasoning at the orchestration level. |
| `designer` | mid | UI/UX design |
| `research` | deep | Multi-workstream research orchestrator |

## Subagents

Dispatched by user-selectable agents. You don't pick these directly.

| Agent | Tier | Role |
|-------|------|------|
| `plan` | deep | Interactive planner with gap analysis (DAG-based). Dispatched by @prime; invoke directly via @plan. |
| `build` | mid | Plan executor. @prime's Execute stage delegates here; invoke directly via @build. |
| `scoper` | deep | Codebase scoping and context gathering. Dispatched by @prime / the scoper wizard; invoke via @scoper. |
| `code-reviewer` | mid | Adversarial code review |
| `code-reviewer-thorough` | deep | Full-suite adversarial review |
| `spec-reviewer` | mid | Spec and requirements review |
| `plan-reviewer` | mid | Adversarial plan review |
| `plan-ultra` | deep | DAG planner for wave-based dispatch |
| `gap-analyzer` | mid | Identifies gaps in plans |
| `architecture-advisor` | deep | Architecture guidance |
| `oracle` | deep | Bounded deep-reasoning consult — one hard question, ~5 tool calls, direct answer with evidence |
| `code-searcher` | fast | Codebase search |
| `docs-maintainer` | mid | Documentation updates |
| `lib-reader` | mid | Library/dependency reader |
| `agents-md-writer` | mid | AGENTS.md generation |
| `debriefer` | mid | Post-run summary |
| `research-web` | deep | Web search subagent |
| `research-local` | deep | Local codebase exploration subagent |
| `research-auto` | deep | Auto-selecting research subagent |
| `council-member` | mid | LLM-council seat — answers and peer-reviews as a pure completion (no tools). Driven by the `council` tool, one seat per configured member model. |

## Autopilot-only

Used by [`glrs loop`](/autopilot). Not user-selectable.

| Agent | Tier | Role |
|-------|------|------|
| `autopilot-prime` | deep | PRIME without question [tool](/harness/tools) |
| `autopilot-fast` | mid | Fast executor for `--fast` sessions |

## Cost-optimized variants

Automatic cost cascading — try cheap first, escalate on failure.

| Agent | Tier | Base |
|-------|------|------|
| `build-cheap` | cheap | `build` |
| `build-deep` | deep | `build` |
| `plan-ultra-cheap` | cheap | `plan-ultra` |

## Tiers

| Tier | Model class | Override |
|------|------------|---------|
| deep | Opus-class | `harness.models.deep` |
| mid | Sonnet-class | `harness.models.mid` |
| mid-execute | Sonnet-class | `harness.models.mid` |
| fast | Haiku-class | `harness.models.fast` |
| cheap | GLM 4.7 Flash | `harness.models.cheap` |

See [configuration](/harness/config) for model overrides.
