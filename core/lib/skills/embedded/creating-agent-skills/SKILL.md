---
name: creating-agent-skills
description: Create or improve Agent Skills when a task needs reusable guidance, workflows, references, or bundled assets.
user-invocable: false
---

# Creating Agent Skills

Use this skill when adding or changing an Agent Skill. Prefer a skill when the
same process, tool use, or domain guidance will help across tasks. Keep product
logic out of a skill: a skill gives instructions; the product enforces behavior.

## Find the host conventions

Before writing, inspect the host's skill discovery code, existing skills, tests,
and package rules. Reuse its discovery path and frontmatter schema. Do not add
special-case registration or runtime branches for one skill.

For agentj embedded skills:

- Put each skill in `core/lib/skills/embedded/<name>/SKILL.md`.
- Keep `name` equal to its directory name: lowercase letters, numbers, and
  single interior hyphens.
- Add `user-invocable: false` for guidance the model may select but users
  should not invoke as a slash command.
- Add every bundled reference, script, or asset below that skill directory.

## Write for progressive disclosure

Make the `description` state when to use the skill. Put the shortest useful
workflow in `SKILL.md`; move detailed, task-specific material into linked files
under `references/`. Use relative links. Give clear prerequisites, commands,
and expected checks, but do not copy unrelated documentation.

Use frontmatter only for supported fields. `allowed-tools` documents the tools a
skill expects; it must not replace the host's permission or safety policy.

## Reuse external material carefully

When adapting an upstream skill, pin or record its source in the skill, preserve
its license and notices, and include linked files needed for the workflow. Keep
attribution and license files with the copied material. Adapt commands only when
the host's tools or safety rules require it.

## Keep actions safe

Say when commands have external side effects, need credentials, alter user data,
or install software. Use the host's normal approval flow for those actions. Add
cleanup steps for sessions, processes, files, and temporary state.

## Validate the whole path

Add or extend a discovery-level test rather than testing private file layout.
Cover valid parsing, expected visibility, and invocation behavior. Run the
project's focused tests, typecheck and formatting checks, relevant evals, and a
package dry run so bundled resources are verified in the published artifact.
