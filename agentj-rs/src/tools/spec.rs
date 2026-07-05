//! The tool schemas advertised to the model (OpenAI function-calling format). Descriptions here are
//! prompt engineering: they are the only documentation the model ever sees for a tool.

use crate::provider::ToolSpec;
use serde_json::json;

/// Tool specs advertised to the model. `delegate` is included only for the primary loop
/// (`allow_delegate`), so subagents can't fan out recursively.
pub fn tool_specs(allow_delegate: bool) -> Vec<ToolSpec> {
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
            name: "web_check".into(),
            description: "Verify a running web page in a real headless browser (you cannot see it otherwise). Loads `url` and reports what's invisible from the source: uncaught exceptions, console.error output, failed network requests (>=400), and — if given — whether `expect_text` appears or `expect_selector` exists. Use this to check FRONTEND/UI work after starting the dev server (job_start), the way you'd run tests for backend work. ok=false on any error or failed assertion. Needs `bun` + Playwright + a Chrome/Chromium.".into(),
            parameters: json!({ "type": "object", "properties": {
                "url": { "type": "string", "description": "page to load, e.g. http://localhost:5173" },
                "wait_for": { "type": "string", "description": "optional CSS selector to wait for before checking" },
                "expect_text": { "type": "string", "description": "optional: assert this text is visible on the page" },
                "expect_selector": { "type": "string", "description": "optional: assert an element matching this CSS selector exists" },
                "timeout_s": { "type": "number", "description": "navigation timeout seconds (default 15)" }
            }, "required": ["url"] }),
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
            name: "delegate".into(),
            description: "Delegate one or more sub-tasks to subagents that each run in their OWN context and return a concise result. Use for any sub-task you expect to take more than ~5 tool calls (investigations, multi-file changes) — it keeps YOUR context small. INDEPENDENT sub-tasks passed in one call run in PARALLEL; sequence dependent work across separate `delegate` calls, feeding results forward. Each result comes back labeled `[subagent i]`.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "description": "One or more independent sub-tasks to run in parallel.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "task": { "type": "string", "description": "The self-contained sub-task instruction." },
                                "title": { "type": "string", "description": "A short 3–8 word label for this sub-task, shown in the UI while it runs (e.g. 'Map the Rust crate')." },
                                "context": { "type": "string", "description": "Optional extra context (paths, findings) the subagent needs." }
                            },
                            "required": ["task"]
                        }
                    }
                },
                "required": ["tasks"]
            }),
        });
    }
    specs
}
