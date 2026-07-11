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

/// The user-level skills directory (`~/.claude/skills`) — playbooks shared across repos.
fn global_skills_dir() -> Option<std::path::PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| std::path::Path::new(&h).join(".claude").join("skills"))
}

/// Collect `<dir>/*/SKILL.md` index lines. `label` renders the path the agent should read —
/// repo-relative for repo skills, absolute for global ones (read_file allows the global skills dir
/// read-only). `seen` dedupes by skill directory name across roots (first collector wins).
fn collect_skills(
    dir: &std::path::Path,
    label: &dyn Fn(&str) -> String,
    seen: &mut std::collections::BTreeSet<String>,
    entries: &mut Vec<String>,
) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let raw = match std::fs::read_to_string(e.path().join("SKILL.md")) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let dir_name = e.file_name().to_string_lossy().to_string();
        if !seen.insert(dir_name.clone()) {
            continue; // repo skill of the same name shadows the global one
        }
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
        entries.push(format!("- {name} — {desc} ({})", label(&dir_name)));
    }
}

/// Task playbooks (skills), indexed by name + description so the agent knows they exist without
/// paying for their bodies — it reads the matching SKILL.md at task time. Two roots: the repo's
/// `.claude/skills` and the user-level `~/.claude/skills` (repo wins on a name collision). Same
/// rationale as embedding AGENTS.md: a playbook the agent doesn't know about might as well not
/// exist (observed live: a PR-feedback run that never touched the repo's addressing-pr-feedback
/// skill).
fn skills_index(cwd: &str) -> Option<String> {
    let repo = std::path::Path::new(cwd).join(".claude").join("skills");
    skills_index_from(&repo, global_skills_dir().as_deref())
}

fn skills_index_from(
    repo_dir: &std::path::Path,
    global_dir: Option<&std::path::Path>,
) -> Option<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut entries: Vec<String> = Vec::new();
    collect_skills(repo_dir, &|d| format!(".claude/skills/{d}/SKILL.md"), &mut seen, &mut entries);
    if let Some(g) = global_dir {
        collect_skills(g, &|d| g.join(d).join("SKILL.md").display().to_string(), &mut seen, &mut entries);
    }
    if entries.is_empty() {
        return None;
    }
    entries.sort();
    Some(enclose(
        "skills",
        &format!(
            "Task playbooks (skills) are available — from this repository and from the user's \
             global skills directory. Before starting a task, check this index; if one matches \
             the task, READ its SKILL.md FIRST (read_file on the path shown) and follow it — a \
             playbook outranks your general approach, the same way AGENTS.md outranks your \
             instincts.\n\n{}",
            entries.join("\n")
        ),
    ))
}

/// `has_artifacts` = a session artifact store is attached (interactive TUI / desktop). Headless
/// `--once` runs have no store — telling them to track `todos` via `save_artifact` would mandate a
/// tool they don't have (observed: wasted calls answered with "no session artifact store attached"),
/// so they get an inline-checklist instruction instead.
fn instructions(has_artifacts: bool) -> String {
    let tracking = if has_artifacts {
        "Track the work in a `todos` artifact — a markdown checklist, one item per line: \
         `- [ ]` pending, `- [~]` in-progress, `- [x]` done. Mark the item you're actively working \
         on `- [~]` so the user can see what's underway, and flip it to `- [x]` when it's finished \
         — keep it current with `edit_artifact` (flip the one marker) rather than rewriting; hold \
         the settled approach in `plan`."
    } else {
        "Track the work as a short checklist in your plan message and restate progress against it \
         as you go — this run has no artifact store, so the checklist lives in your replies."
    };
    [
        enclose(
            "explore",
            "Always explore and always plan before you take any action. Build a HIGH-CONFIDENCE \
             understanding of the context from HARD EVIDENCE — read the code, run commands, look at \
             the real files — before you act; never work from assumption.",
        ),
        enclose(
            "subagents",
            "Use subagents as much as possible. Map the \
             DEPENDENCIES first — which sub-tasks are independent, which need another's output — then \
             express that DAG in one `run_subagents` call: independent tasks run in PARALLEL, and a \
             task that consumes another's result gets `after:[…]` those tasks, so it runs in a later \
             stage and receives their results. A planner runs `after` the scouts that feed it, never \
             in the same stage. This applies to EVERY kind of task, not just building things: \
             answering a question about the code, tracking down a bug, reviewing a change, \
             refactoring, or auditing all fan out the same way. Delegate the reading and exploring to \
             them; you synthesize and decide.",
        ),
        enclose(
            "plan",
            &format!(
                "After scouting to the appropriate degree, ALWAYS share your PLAN before you take action — \
                 don't dive in, and don't dump a wall of questions in chat instead. State the approach and \
                 what you'll do, and split what's still open in two: DECISIONS you can default (stack, \
                 storage, file layout) — give each your recommendation and move on — and QUESTIONS only \
                 the user can answer (what they actually want) — put these to them, each with your \
                 recommended default, never silently pre-decided. Then, once aligned, execute. Scale the \
                 plan to the task — a one-line change's plan is a sentence, but you still say it before \
                 acting. {tracking}"
            ),
        ),
        enclose(
            "environment",
            "The environment is provisioned DETERMINISTICALLY, not per conversation: the repo's \
             `.aj/hooks/worktree_new` script runs automatically when agentj opens a new worktree, \
             before you ever act. If you hit a missing/broken tool anyway (pnpm not found, a \
             runtime absent), that is a HOLE IN THE HOOK: fix the environment for the task at hand \
             (`packageManager` in package.json → `corepack enable`, version-manager shims, \
             `node_modules/.bin`), then fold the working fix into `.aj/hooks/worktree_new` — create \
             it if absent — so it is provisioned automatically for every future worktree and never \
             debugged again. Never end a task with \"your shell lacks X\" — that is a diagnosis, \
             not a result.",
        ),
        enclose(
            "verify",
            "Always verify the user's request has been fulfilled beyond a shadow of a doubt. Check your \
             work no matter what the task was. If you answered a question about the codebase, \
             double-check your reasoning and make sure your conclusion rests on hard evidence. If you \
             made a code change, run the tests, run the code, and manually exercise it — cURL an \
             endpoint, run a script, or drive the UI with a browser. And RUN THE LAST MILE: when the \
             remaining step is a command your tools can run (a dry-run, a backfill, a migration \
             check), run it yourself — long ones via job_start — and deliver its OUTPUT; a command \
             handed back to the user to paste is an unfinished task. Hand a step back only when it \
             genuinely requires the user (credentials you don't have, an approval, an irreversible \
             production effect), and say exactly why it's theirs.",
        ),
    ]
    .join("\n\n")
}


/// Build the system prompt for a session rooted at `cwd`. `has_artifacts` = a session artifact
/// store is attached (interactive runs); headless `--once` passes false and gets checklist-in-reply
/// tracking instead of artifact tooling it doesn't have.
pub fn system_prompt(cwd: &str, company: Option<&str>, has_artifacts: bool) -> String {
    let mut sections = vec![
        identity("a staff software engineer and architect", company),
        working_context(cwd),
    ];
    sections.extend(project_docs(cwd));
    sections.extend(skills_index(cwd));
    sections.push(instructions(has_artifacts));
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
        let p = system_prompt("/repo", None, true);
        // each idea is its own opening/closing tagged section
        assert!(p.contains("<explore>") && p.contains("</explore>"));
        assert!(p.contains("<subagents>") && p.contains("</subagents>"));
        assert!(p.contains("<plan>") && p.contains("</plan>"));
        assert!(p.contains("<verify>") && p.contains("</verify>"));
        // plan-first: always share the plan before acting; genuinely-open questions go to the user
        assert!(p.contains("ALWAYS share your PLAN before you take action"));
        assert!(p.contains("QUESTIONS only the user can answer"));
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
        // no SPEAR, no epic/manager doctrine, no removed tools/features survive
        assert!(!p.contains("SPEAR"));
        assert!(!p.contains("engineer_start"));
        assert!(!p.contains("web_check"));
        assert!(!p.contains(".aj/epic/plan.md"));
        // the reverted blueprint / questioner arc leaves no trace in the corpus
        assert!(!p.contains("blueprint"));
        assert!(!p.contains("read_skill"));
        assert!(!p.contains("questioner"));
    }

    #[test]
    fn environment_and_last_mile_doctrine_are_present() {
        let p = system_prompt("/repo", None, true);
        // Environments are provisioned by the worktree_new hook; a gap is fixed INTO the hook.
        assert!(p.contains("<environment>") && p.contains("</environment>"));
        assert!(p.contains(".aj/hooks/worktree_new"));
        assert!(p.contains("HOLE IN THE HOOK"));
        assert!(p.contains("corepack enable"));
        assert!(!p.contains("workspace_notes"), "the notes layer is gone");
        assert!(!p.contains("`remember`"), "the notes tool is gone");
        // The last mile is run, not handed back.
        assert!(p.contains("RUN THE LAST MILE"));
        assert!(p.contains("a command handed back to the user to paste is an unfinished task"));
        assert!(p.contains("irreversible"));
    }

    #[test]
    fn headless_prompt_never_mandates_artifact_tools_it_doesnt_have() {
        // `--once` runs have no session store: save/edit_artifact aren't advertised, so the prompt
        // must not tell the model to use them (that instruction burned steps on every eval run).
        let headless = system_prompt("/repo", None, false);
        assert!(!headless.contains("`todos` artifact"));
        assert!(!headless.contains("edit_artifact"));
        assert!(headless.contains("checklist"), "still tracks progress, inline");
        // Interactive runs keep the artifact workflow.
        let interactive = system_prompt("/repo", None, true);
        assert!(interactive.contains("`todos` artifact"));
        assert!(interactive.contains("edit_artifact"));
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
        // The injectable form isolates the test from the developer's real ~/.claude/skills.
        let repo_skills = dir.join(".claude/skills");
        // No skills anywhere → no section.
        std::fs::create_dir_all(&dir).unwrap();
        assert!(skills_index_from(&repo_skills, None).is_none());

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

        let p = skills_index_from(&repo_skills, None).unwrap();
        assert!(p.contains("<skills>"));
        assert!(p.contains("addressing-pr-feedback — Fetch review threads, fix, push, THEN resolve."));
        assert!(p.contains("(.claude/skills/addressing-pr-feedback/SKILL.md)"));
        assert!(p.contains("- deploy — (no description — read the file)"), "{p}");
        assert!(p.contains("READ its SKILL.md FIRST"));
        // The full prompt embeds the index (via the real global dir, which may add more entries).
        let full = system_prompt(dir.to_str().unwrap(), None, true);
        assert!(full.contains("(.claude/skills/addressing-pr-feedback/SKILL.md)"));
        // Subagents get the same index.
        assert!(subagent_system_prompt(crate::agent::AgentType::Executor, dir.to_str().unwrap())
            .contains("(.claude/skills/addressing-pr-feedback/SKILL.md)"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn global_skills_merge_and_repo_shadows_on_name_collision() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-global-skills-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = dir.join("repo/.claude/skills");
        let global = dir.join("home/.claude/skills");
        for (root, skills) in [
            (&repo, vec![("linear", "Repo linear playbook.")]),
            (&global, vec![("linear", "GLOBAL linear playbook."), ("deploy-notes", "Global deploy notes.")]),
        ] {
            for (name, desc) in skills {
                let d = root.join(name);
                std::fs::create_dir_all(&d).unwrap();
                std::fs::write(
                    d.join("SKILL.md"),
                    format!("---\nname: {name}\ndescription: {desc}\n---\nbody\n"),
                )
                .unwrap();
            }
        }
        let p = skills_index_from(&repo, Some(&global)).unwrap();
        // Repo wins the name collision; the global-only skill still appears, with an ABSOLUTE path.
        assert!(p.contains("linear — Repo linear playbook."));
        assert!(!p.contains("GLOBAL linear playbook."));
        assert!(p.contains("deploy-notes — Global deploy notes."));
        assert!(p.contains(&global.join("deploy-notes").join("SKILL.md").display().to_string()));
        // Global-only skills still index when the repo has none.
        let p = skills_index_from(&dir.join("repo-without-skills"), Some(&global)).unwrap();
        assert!(p.contains("GLOBAL linear playbook."));
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
        assert!(!system_prompt(root, None, true).contains("<project_docs>"));

        std::fs::write(dir.join("AGENTS.md"), "# The Map\nBuild with `make x`.").unwrap();
        let p = system_prompt(root, None, true);
        assert!(p.contains("<project_docs>"));
        assert!(p.contains("Build with `make x`."));
        assert!(p.contains("Subdirectories may carry their own AGENTS.md"));

        // Oversized docs are truncated with a pointer, not dropped.
        std::fs::write(dir.join("AGENTS.md"), "x".repeat(30_000)).unwrap();
        let p = system_prompt(root, None, true);
        assert!(p.contains("truncated — read AGENTS.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
