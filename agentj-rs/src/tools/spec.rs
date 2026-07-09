//! The tool schemas advertised to the model (OpenAI function-calling format). Descriptions here are
//! prompt engineering: they are the only documentation the model ever sees for a tool.

use crate::provider::ToolSpec;
use serde_json::json;

/// Tool specs advertised to the model. `run_subagents` is included only for the primary loop
/// (`allow_delegate`), so subagents can't fan out recursively. `save_artifact`/`read_artifact`
/// require an attached session store (`has_session`) — only the interactive primary persists
/// artifacts.
pub fn tool_specs(
    allow_delegate: bool,
    has_session: bool,
    agent_type: Option<crate::agent::AgentType>,
) -> Vec<ToolSpec> {
    let mut specs = vec![
        ToolSpec {
            name: "read_file".into(),
            description: "Read a UTF-8 text file (relative to repo root), returned with line numbers. Pass offset/limit (1-based) for a span.".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" }, "offset": { "type": "number" }, "limit": { "type": "number" } }, "required": ["path"] }),
        },
        ToolSpec {
            name: "write_file".into(),
            description: "Create or overwrite a file with the given content.".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] }),
        },
        ToolSpec {
            name: "edit_file".into(),
            description: "Replace exact strings in a file. BATCH related fixes: pass `edits` (an array of {old_string,new_string}) to apply several replacements in ONE call — far cheaper than one call per fix. Edits apply in order and are atomic (any failure writes nothing). Each old_string must occur exactly once unless its replace_all is set. The result echoes the changed regions, so you do NOT need to re-read the file to verify.".into(),
            parameters: json!({ "type": "object", "properties": {
                "path": { "type": "string" },
                "edits": { "type": "array", "description": "batch form: replacements applied in order", "items": { "type": "object", "properties": { "old_string": { "type": "string" }, "new_string": { "type": "string" }, "replace_all": { "type": "boolean" } }, "required": ["old_string", "new_string"] } },
                "old_string": { "type": "string", "description": "single-edit form" },
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean", "description": "replace every occurrence instead of requiring uniqueness" }
            }, "required": ["path"] }),
        },
        ToolSpec {
            name: "edit_lines".into(),
            description: "Replace an inclusive line range (1-based, the numbers read_file shows). `expect` = the first few words of the current start_line, as a drift guard: on mismatch you get the current region back to re-anchor from. Empty content deletes the range. Use when exact-string matching is awkward (heavy whitespace, duplicated text); result echoes the new region.".into(),
            parameters: json!({ "type": "object", "properties": {
                "path": { "type": "string" },
                "start_line": { "type": "integer" },
                "end_line": { "type": "integer" },
                "expect": { "type": "string", "description": "prefix of the CURRENT first line being replaced (leading whitespace ignored)" },
                "content": { "type": "string", "description": "replacement lines; empty string deletes the range" }
            }, "required": ["path", "start_line", "end_line", "expect", "content"] }),
        },
        ToolSpec {
            name: "list_dir".into(),
            description: "List the entries of a directory (relative to repo root). Directories end with /.".into(),
            parameters: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        },
        ToolSpec {
            name: "glob".into(),
            description: "Find files by glob pattern relative to the repo root (e.g. '**/*.rs', 'README*'). Respects .gitignore.".into(),
            parameters: json!({ "type": "object", "properties": { "pattern": { "type": "string" } }, "required": ["pattern"] }),
        },
        ToolSpec {
            name: "grep".into(),
            description: "Search file contents with a regex from the repo root. Returns matching lines with line numbers.".into(),
            parameters: json!({ "type": "object", "properties": { "pattern": { "type": "string" }, "path": { "type": "string" } }, "required": ["pattern"] }),
        },
        ToolSpec {
            name: "bash".into(),
            description: "Run a shell command from the repo root (bash -lc). Use for builds, tests, git, etc. Output truncated; bounded to 120s by default, or `timeout_s` (1..=600) if given.".into(),
            parameters: json!({ "type": "object", "properties": { "command": { "type": "string" }, "timeout_s": { "type": "number", "description": "kill the command after this many seconds (clamped to 1..=600; default 120)" } }, "required": ["command"] }),
        },
        ToolSpec {
            name: "job_start".into(),
            description: "Start a long-running command in the BACKGROUND (dev server, slow test suite, `gh pr checks --watch`). Returns a job id immediately — keep working on other things. You'll be nudged when it finishes, or after `timeout_s` if it's still running. Prefer this over `bash` for anything slow.".into(),
            parameters: json!({ "type": "object", "properties": { "command": { "type": "string" }, "timeout_s": { "type": "number", "description": "fallback: nudge you if the job is still running after this many seconds" } }, "required": ["command"] }),
        },
        ToolSpec {
            name: "job_check".into(),
            description: "Check background jobs — status (running/exited) + recent output. Omit `id` for all jobs. Non-blocking.".into(),
            parameters: json!({ "type": "object", "properties": { "id": { "type": "number" } } }),
        },
        ToolSpec {
            name: "job_stop".into(),
            description: "Kill a background job by id.".into(),
            parameters: json!({ "type": "object", "properties": { "id": { "type": "number" } }, "required": ["id"] }),
        },
    ];
    if allow_delegate {
        specs.push(ToolSpec {
            name: "run_subagents".into(),
            description: "Run one or more sub-tasks as TYPED subagents that each run in their OWN context and return a concise result. Use for a sub-task of more than ~5 tool calls, or that runs in parallel / needs isolated context — it keeps YOUR context small. This is a dependency DAG: tasks WITHOUT `after` run in PARALLEL; a task with `after:[i,…]` runs in a LATER stage and RECEIVES those tasks' results as its context. So a scout→planner flow is ONE call — put the scouts first, give the planner `after` those scouts — instead of running the planner alongside the scouts it depends on. Each result comes back labeled `[subagent i]`, where i is the task's 0-based position in `tasks` (which is also what `after` references). Pick the `type` that matches the work — each runs with a scoped toolset: `scout` (read-only investigation / answer a question), `planner` (read-only design / decompose / weigh options), `reviewer` (adversarial verify a diff or plan — read + run checks, no edits), `executor` (make a targeted change on files you name — the default). Write briefs that spend the budget well: name the exact files/paths/commands you already located and state precisely what to return.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "description": "Sub-tasks. Those without `after` run in parallel; use `after` to sequence dependent ones (a planner after its scouts).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "task": { "type": "string", "description": "The self-contained sub-task instruction." },
                                "type": { "type": "string", "enum": ["scout", "planner", "reviewer", "executor"], "description": "The kind of subagent (default: executor). scout/planner/reviewer are read-only; executor makes changes." },
                                "title": { "type": "string", "description": "A short 3–8 word label for this sub-task, shown in the UI while it runs (e.g. 'Map the Rust crate')." },
                                "context": { "type": "string", "description": "Optional extra context (paths, findings) the subagent needs." },
                                "after": { "type": "array", "items": { "type": "integer" }, "description": "0-based indices of sub-tasks in THIS call that must finish first; their results are fed to this task as context. Omit for an independent task that can run immediately." }
                            },
                            "required": ["task"]
                        }
                    }
                },
                "required": ["tasks"]
            }),
        });
    }
    if allow_delegate && has_session {
        specs.push(ToolSpec {
            name: "save_artifact".into(),
            description: "Persist a named artifact for THIS session, stored outside the repo and keyed to the session so it never pollutes the working tree and a fresh session never inherits it. Overwrites the artifact each call — for small incremental changes use `edit_artifact` instead. Three artifacts are conventional: `plan` (markdown — the settled APPROACH and its rationale; write it once the design is decided, revise only on new info) and `todos` (a markdown CHECKLIST, one item per line as `- [ ] pending` / `- [x] done` — the app shows it live). `plan` and `todos` are handed back to you on resume, so keep todos current — it's what tells a resumed run what's left. The third is `blueprint` (format:\"html\" — a self-contained interactive HTML page: mockups, hierarchy, diagrams). Saving an html artifact OPENS IT IN THE USER'S BROWSER, so build a `blueprint` when a picture would align you with the user faster than prose — during scoping/planning, show what you understand and what you propose, and get their buy-in before you build.".into(),
            parameters: json!({ "type": "object", "properties": {
                "name": { "type": "string", "description": "artifact name, e.g. \"plan\", \"todos\", \"blueprint\"" },
                "content": { "type": "string", "description": "the full artifact content (replaces any prior version)" },
                "format": { "type": "string", "enum": ["markdown", "html"], "description": "\"markdown\" (default) for plan/todos/notes; \"html\" for a blueprint — a self-contained page opened in the user's browser on save" }
            }, "required": ["name", "content"] }),
        });
        specs.push(ToolSpec {
            name: "edit_artifact".into(),
            description: "Edit an EXISTING artifact in place with exact-string replacements — far cheaper than re-sending the whole thing with save_artifact. Use it for incremental changes, especially `todos` that change one line at a time: flip `- [ ] task` to `- [x] task`, or append a line. `edits` is applied in order (first occurrence of each old_string). The result echoes the updated artifact.".into(),
            parameters: json!({ "type": "object", "properties": {
                "name": { "type": "string", "description": "the artifact to edit, e.g. \"todos\"" },
                "edits": { "type": "array", "description": "replacements applied in order", "items": { "type": "object", "properties": {
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" }
                }, "required": ["old_string", "new_string"] } }
            }, "required": ["name", "edits"] }),
        });
        specs.push(ToolSpec {
            name: "read_artifact".into(),
            description: "Read back a named artifact saved earlier in this session with `save_artifact` (e.g. your \"plan\" or \"todos\"). Useful after a long stretch when it may have scrolled out of context.".into(),
            parameters: json!({ "type": "object", "properties": {
                "name": { "type": "string", "description": "artifact name to read" }
            }, "required": ["name"] }),
        });
    }
    // A type-scoped subagent only sees the built-in tools its type allows (MCP specs, added by the
    // caller, always pass through — they're the user's integrations, guided by the type prompt).
    if let Some(t) = agent_type {
        specs.retain(|s| t.allows(&s.name));
    }
    specs
}
