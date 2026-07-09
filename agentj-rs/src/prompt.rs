//! The system prompt, assembled from tagged sections. Port of `system-prompt.ts`.

fn enclose(tag: &str, body: &str) -> String {
    format!("<{tag}>\n{}\n</{tag}>", body.trim())
}

fn identity(role: &str, company: Option<&str>) -> String {
    let at = company.map(|c| format!(", at {c}")).unwrap_or_default();
    enclose(
        "identity",
        &format!("You are Agent J, {role}{at}. You get real engineering work done in the user's repository — carefully, and without hand-holding."),
    )
}

fn working_context(cwd: &str) -> String {
    enclose(
        "context",
        &format!("Your current working directory is {cwd}. You have full access to it through your tools — read files, search, edit, and run commands. Act; don't ask for permission to use a tool, and get things done."),
    )
}

/// Character cap on the embedded AGENTS.md — beyond this it's truncated with a pointer to read the
/// rest via tools. Generous: docs this size are the exception, not the rule.
const MAX_DOC_CHARS: usize = 24_000;

/// The repo's root `AGENTS.md`, embedded so the agent starts every session already knowing the
/// project's map and conventions (this is what `/init` writes them for). `None` when absent/empty.
fn project_docs(cwd: &str) -> Option<String> {
    let raw = std::fs::read_to_string(std::path::Path::new(cwd).join("AGENTS.md")).ok()?;
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let body = if text.chars().count() > MAX_DOC_CHARS {
        let clipped: String = text.chars().take(MAX_DOC_CHARS).collect();
        format!("{clipped}\n… [truncated — read AGENTS.md for the rest]")
    } else {
        text.to_string()
    };
    Some(enclose(
        "project_docs",
        &format!(
            "The repository's AGENTS.md — its map and conventions. Follow it; it outranks your \
             general instincts about how projects are usually laid out.\n\n{body}\n\n\
             Subdirectories may carry their own AGENTS.md with local conventions — read it before \
             working inside one."
        ),
    ))
}

/// Cap on a skill description in the index — one line each; the agent reads the body at task time.
const MAX_SKILL_DESC: usize = 200;

/// Minimal YAML-frontmatter reader: top-level `key: value` pairs between the leading `---` fence
/// and the next. Handles folded/literal scalars (`>`, `>-`, `|`, `|-`) by joining the indented
/// continuation lines — enough for SKILL.md name/description, not a YAML parser.
fn frontmatter(raw: &str) -> std::collections::BTreeMap<String, String> {
    let mut map = std::collections::BTreeMap::new();
    let mut lines = raw.lines().peekable();
    if lines.next().map(str::trim) != Some("---") {
        return map;
    }
    while let Some(line) = lines.next() {
        if line.trim() == "---" {
            break;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        if line.starts_with([' ', '\t']) {
            continue; // nested mapping — not a top-level key
        }
        let mut value = v.trim().to_string();
        if matches!(value.as_str(), ">" | ">-" | "|" | "|-" | "") {
            let mut parts = Vec::new();
            while let Some(next) = lines.peek() {
                if next.starts_with([' ', '\t']) && !next.trim().is_empty() {
                    parts.push(next.trim().to_string());
                    lines.next();
                } else {
                    break;
                }
            }
            value = parts.join(" ");
        }
        map.insert(k.trim().to_string(), value);
    }
    map
}

/// Repo playbooks (`.claude/skills/*/SKILL.md`), indexed by name + description so the agent knows
/// they exist without paying for their bodies — it reads the matching SKILL.md at task time. Same
/// rationale as embedding AGENTS.md: a playbook the agent doesn't know about might as well not
/// exist (observed live: a PR-feedback run that never touched the repo's addressing-pr-feedback
/// skill).
fn skills_index(cwd: &str) -> Option<String> {
    let dir = std::path::Path::new(cwd).join(".claude").join("skills");
    let rd = std::fs::read_dir(&dir).ok()?;
    let mut entries: Vec<String> = Vec::new();
    for e in rd.flatten() {
        let raw = match std::fs::read_to_string(e.path().join("SKILL.md")) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let dir_name = e.file_name().to_string_lossy().to_string();
        let fm = frontmatter(&raw);
        let name = fm
            .get("name")
            .filter(|n| !n.is_empty())
            .cloned()
            .unwrap_or_else(|| dir_name.clone());
        let desc = fm
            .get("description")
            .filter(|d| !d.is_empty())
            .map(|d| d.chars().take(MAX_SKILL_DESC).collect::<String>())
            .unwrap_or_else(|| "(no description — read the file)".to_string());
        entries.push(format!("- {name} — {desc} (.claude/skills/{dir_name}/SKILL.md)"));
    }
    if entries.is_empty() {
        return None;
    }
    entries.sort();
    Some(enclose(
        "skills",
        &format!(
            "The repository ships task playbooks (skills). Before starting a task, check this \
             index; if one matches the task, READ its SKILL.md FIRST and follow it — a repo \
             playbook outranks your general approach, the same way AGENTS.md outranks your \
             instincts.\n\n{}",
            entries.join("\n")
        ),
    ))
}

fn instructions() -> String {
    [
        enclose(
            "explore",
            "Always explore and always plan before you take any action. Build a HIGH-CONFIDENCE \
             understanding of the context from HARD EVIDENCE — read the code, run commands, look at \
             the real files — before you act; never work from assumption.",
        ),
        enclose(
            "subagents",
            "Use subagents as much as possible. Map the DEPENDENCIES first — which sub-tasks are \
             independent, and which need another's output — then express that DAG in one \
             `run_subagents` call: independent tasks run in PARALLEL, and a task that consumes \
             another's result gets `after:[…]` those tasks, so it runs in a later stage and receives \
             their results. A planner runs `after` the scouts that feed it, never in the same stage. \
             This applies to EVERY kind of task, not just building things: answering a question about \
             the code, tracking down a bug, reviewing a change, refactoring, or auditing all fan out \
             the same way. Delegate the reading and exploring to them; you synthesize and decide.",
        ),
        enclose(
            "align",
            "For anything beyond a trivial change, ALIGN with the user before you build. When a \
             picture would land faster than prose, save a `blueprint` (`save_artifact` with \
             format:\"html\") — a self-contained, RESPONSIVE HTML page whose UI mockups are \
             HIGH-FIDELITY and FULLY INTERACTIVE (they actually work — tabs switch, forms respond), \
             that concisely lays out the DECISIONS the user needs to make, each with your \
             recommendation. Read the `blueprint` skill first (`read_skill(\"blueprint\")`) — it's \
             the design brief for doing each of those well. It opens in their browser. Track the work \
             in a `todos` artifact — a markdown checklist, one item per line (`- [ ]` pending, `- [x]` \
             done) — kept current with `edit_artifact` (flip a checkbox) rather than rewritten; hold \
             the settled approach in `plan`.",
        ),
        enclose(
            "verify",
            "Always verify the user's request has been fulfilled beyond a shadow of a doubt. Check your \
             work no matter what the task was. If you answered a question about the codebase, \
             double-check your reasoning and make sure your conclusion rests on hard evidence. If you \
             made a code change, run the tests, run the code, and manually exercise it — cURL an \
             endpoint, run a script, or drive the UI with a browser.",
        ),
    ]
    .join("\n\n")
}


/// Build the system prompt for a session rooted at `cwd`.
pub fn system_prompt(cwd: &str, company: Option<&str>) -> String {
    let mut sections = vec![
        identity("a staff software engineer and architect", company),
        working_context(cwd),
    ];
    sections.extend(project_docs(cwd));
    sections.extend(skills_index(cwd));
    sections.push(instructions());
    sections.join("\n\n")
}

/// The rules every subagent shares regardless of type — efficiency and the return contract.
/// Prepended by the type's own role identity (see `crate::agent::AgentType::identity`).
fn subagent_tail() -> &'static str {
    "Do EXACTLY the one sub-task you're given — nothing more, no scope creep. Your efficiency bar is \
     strict: the FEWEST tool calls that produce hard evidence. Batch related commands into one call; \
     run ONE broad query and filter its output rather than repeating a query with shifted parameters; \
     read only the files your brief names or your evidence demands. (Exception: reproducing \
     nondeterministic behavior — flaky tests, races — is done by rerunning the SAME command; that \
     repetition is the method, not waste.) If you discovered independent follow-up work outside your \
     sub-task, do NOT do it — end with a `frontier:` line listing it so the main agent can schedule it. \
     Your entire final reply becomes the result handed back to the main agent — tight and \
     self-contained, no filler, no meta-commentary."
}

/// System prompt for a subagent of a given `type`. Every section is its own opening/closing tag:
/// the type's `<role>` identity, the shared `<contract>`, an optional `<rubric>` naming the exact
/// output expected, then the SAME `<context>` / project docs / skills the primary gets — a subagent
/// that re-derives the repo layout from scratch burns its budget (measured live).
pub fn subagent_system_prompt(agent_type: crate::agent::AgentType, cwd: &str) -> String {
    let mut sections = vec![
        enclose("role", agent_type.identity()),
        enclose("contract", subagent_tail()),
    ];
    if let Some(rubric) = agent_type.report_rubric() {
        sections.push(enclose("rubric", rubric));
    }
    sections.push(working_context(cwd));
    sections.extend(project_docs(cwd));
    sections.extend(skills_index(cwd));
    sections.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prime_prompt_is_the_simple_explore_delegate_verify_triad() {
        let p = system_prompt("/repo", None);
        // each idea is its own opening/closing tagged section
        assert!(p.contains("<explore>") && p.contains("</explore>"));
        assert!(p.contains("<subagents>") && p.contains("</subagents>"));
        assert!(p.contains("<align>") && p.contains("</align>"));
        assert!(p.contains("<verify>") && p.contains("</verify>"));
        // align: a visual blueprint for buy-in + a todos artifact for tracking
        assert!(p.contains("save a `blueprint`"));
        assert!(p.contains("`todos`"));
        // 1. explore + plan before acting, from hard evidence
        assert!(p.contains("Always explore and always plan before you take any action"));
        assert!(p.contains("HARD EVIDENCE"));
        assert!(p.contains("never work from assumption"));
        // 2. subagents, in parallel — and it applies to EVERY kind of task, not just building
        assert!(p.contains("Use subagents as much as possible"));
        assert!(p.contains("in PARALLEL"));
        assert!(p.contains("one `run_subagents` call"));
        assert!(p.contains("EVERY kind of task"));
        // dependency-aware: map a DAG and express it with `after` (a planner after its scouts)
        assert!(p.contains("Map the DEPENDENCIES"));
        assert!(p.contains("A planner runs `after` the scouts"));
        // 3. verify beyond a shadow of a doubt, matched to the kind of work
        assert!(p.contains("beyond a shadow of a doubt"));
        assert!(p.contains("Check your work no matter what the task was"));
        assert!(p.contains("run the tests, run the code, and manually exercise it"));
        // no SPEAR, no epic/manager doctrine, no removed tools survive
        assert!(!p.contains("SPEAR"));
        assert!(!p.contains("engineer_start"));
        assert!(!p.contains("web_check"));
        assert!(!p.contains(".aj/epic/plan.md"));
    }

    #[test]
    fn subagents_get_the_same_context_and_project_docs() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-subprompt-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        std::fs::write(dir.join("AGENTS.md"), "# Map\nRun `make check`.").unwrap();

        let p = subagent_system_prompt(crate::agent::AgentType::Executor, root);
        assert!(p.contains("EXECUTOR subagent"), "carries the type's specialized identity");
        assert!(p.contains("Do EXACTLY the one sub-task"), "keeps the shared worker contract");
        assert!(p.contains(root), "knows its working directory");
        assert!(p.contains("Run `make check`."), "gets the project docs");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skills_are_indexed_from_claude_skills_when_present() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-skills-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = dir.to_str().unwrap().to_string();
        // No .claude/skills → no section.
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!system_prompt(&root, None).contains("<skills>"));

        // One skill with frontmatter (folded description), one without any frontmatter.
        let pr = dir.join(".claude/skills/addressing-pr-feedback");
        std::fs::create_dir_all(&pr).unwrap();
        std::fs::write(
            pr.join("SKILL.md"),
            "---\nname: addressing-pr-feedback\ndescription: >-\n  Fetch review threads,\n  fix, push, THEN resolve.\n---\n# body\n",
        )
        .unwrap();
        let bare = dir.join(".claude/skills/deploy");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::write(bare.join("SKILL.md"), "# Deploying\nSteps…\n").unwrap();

        let p = system_prompt(&root, None);
        assert!(p.contains("<skills>"));
        assert!(p.contains("addressing-pr-feedback — Fetch review threads, fix, push, THEN resolve."));
        assert!(p.contains("(.claude/skills/addressing-pr-feedback/SKILL.md)"));
        assert!(p.contains("- deploy — (no description — read the file)"), "{p}");
        assert!(p.contains("READ its SKILL.md FIRST"));
        // Subagents get the same index.
        assert!(subagent_system_prompt(crate::agent::AgentType::Executor, &root).contains("<skills>"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agents_md_is_embedded_when_present_and_skipped_when_not() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-prompt-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        // No AGENTS.md → no project_docs section.
        assert!(!system_prompt(root, None).contains("<project_docs>"));

        std::fs::write(dir.join("AGENTS.md"), "# The Map\nBuild with `make x`.").unwrap();
        let p = system_prompt(root, None);
        assert!(p.contains("<project_docs>"));
        assert!(p.contains("Build with `make x`."));
        assert!(p.contains("Subdirectories may carry their own AGENTS.md"));

        // Oversized docs are truncated with a pointer, not dropped.
        std::fs::write(dir.join("AGENTS.md"), "x".repeat(30_000)).unwrap();
        let p = system_prompt(root, None);
        assert!(p.contains("truncated — read AGENTS.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
