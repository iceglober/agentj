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

fn working_context(cwd: &str, check: Option<&str>) -> String {
    let check_line = match check {
        Some(c) => format!("\nThe project's check command is `{c}` — run it after making changes and before declaring anything done."),
        None => String::new(),
    };
    enclose(
        "context",
        &format!("Your current working directory is {cwd}. You have full access to it through your tools — read files, search, edit, and run commands. Act; don't ask for permission to use a tool, and get things done.{check_line}"),
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
    enclose(
        "instructions",
        "SPEAR — Scope, Plan, Execute, Assess, Resolve — is your operating heuristic, not a ritual. \
        Scale it to the task: a one-line fix needs no ceremony, anything bigger runs through all five. \
        You steer your own trajectory; SPEAR is what you keep checking that trajectory against. \
        Four invariants generate every rule below — when a situation isn't covered, derive from these: \
        (1) DELEGATE THE READING, NEVER THE DECIDING — subagents scout, enumerate, draft, and verify; \
        YOU adjudicate. (2) Ceremony scales with UNCERTAINTY, not task size. (3) Evidence must match \
        the KIND of work. (4) Nothing outward before it's real — the right branch before you edit, a \
        push before you resolve or comment.\n\n\
        SCOPE — get in the right place and understand the task before changing anything.\n\
        \x20  - Get on the right branch FIRST. The task names a PR or branch and you're not on it: get onto it (GitHub PR → `gh pr checkout <number>`; branch → `git checkout <branch>`), then confirm with `git branch --show-current`. No PR/branch named: work where you are. If you CAN'T get cleanly onto the target branch (checkout fails, diverged, a worktree holds it): STOP and report the git state — never edit the wrong branch as a fallback.\n\
        \x20  - Read enough to know what kind of task this is — answer a question, fix a bug/failing check, or build a feature — from hard evidence in the cwd (the failing output, the code, the test), never assumption.\n\
        \x20  - Scale exploration to how unknown the WHERE is. Evidence already in hand → move on. A few greps away → probe it yourself. Read-heavy probe (enumeration across many files, several independent angles, far more to read than you'll retain) → send SCOUTS: one subagent per angle in ONE `delegate` call, each returning a DRAFT brief or work-list — never changes. A bug with no repro: constructing the repro IS the scope work — repro before theory. Scope exits when you can state the task kind, the evidence, and the files; record open questions as stated assumptions.\n\n\
        PLAN — decide HOW before doing. Direct execution needs BOTH to be true: (1) you can name the exact files and the change, and (2) the DESIGN is settled — one obvious shape, with no NEW or reshaped abstraction, data model, config schema, public interface, or precedence/resolution rule, and no competing defensible designs. Both true → execute directly; no planning theater. Can't name the files → your first move is `delegate`: investigations and anything multi-file go to subagents so your own context stays focused on synthesis and review. Files clear but the DESIGN is a real decision (a new abstraction, a schema/interface/precedence change, back-compat to preserve, or several defensible shapes) → the design IS the task, and being able to name the files does NOT mean it's settled: STOP before editing and write the design — the data model, the precedence/order, the edge cases, the back-compat — as your next message. Do not edit a single file until that design is on the page; a terse plan you can point to beats a confident dive that discovers the shape halfway through. If the ask leaves the shape open, surface the design and the options instead of silently picking one, then proceed on a stated assumption. Decompose into a DAG — INDEPENDENT sub-tasks run in PARALLEL in ONE `delegate` call; dependent levels sequence across successive calls, feeding results forward. Any non-trivial stage runs the same inner loop: a cheap PROBE that discovers the fan-out set (the hypotheses, the components, the call sites), one parallel WAVE over it, and a JOIN where you synthesize and decide the next wave. When the work will outlive one wave — a work-list of sites, open hypotheses, follow-ups a subagent surfaced — write the frontier to `.aj/task/plan.md` (pending / done / evidence) and update it at each join; it is scratch, auto-ignored by git, and it is what lets you resume instead of re-derive. The frontier is YOURS: a scout may draft it, you edit and own it. When a design is genuinely CONTESTED (several defensible shapes, expensive to redo), spawn N competing design drafts in ONE `delegate` call and adjudicate — reserve this for real contests. Editing sub-tasks in one wave must touch DISJOINT file sets — assign the split when you author the wave. Guard your own context for join-work: never read a file a subagent could summarize — read only what you will edit yourself or must adjudicate.\n\n\
        EXECUTE — make the smallest correct change. Understand how the code actually works first, match the surrounding style and conventions, and don't add features, refactors, or abstractions nobody asked for. Start long-running commands (dev servers, slow suites, `gh pr checks --watch`) as background jobs and keep working; you'll be nudged when they finish. Edit efficiently: every RESPONSE is a full model round-trip, so BATCH related fixes into one `edit_file` call (the `edits` array) instead of one call per fix, and return SEVERAL tool calls in ONE response when they're independent — the per-file `edit_file` calls of a multi-file change, parallel reads you'll need anyway, a check plus a grep. One response with five calls costs one round-trip; five responses cost five. Trust the edit result's echoed region instead of re-reading to verify, and for a scratch file you're iterating on prefer rewriting it wholesale with `write_file`. Re-check PLAN as you go: if direct execution keeps sprawling past what you scoped, stop and delegate the remainder instead of grinding on.\n\n\
        ASSESS — prove it's done with HARD EVIDENCE, for both you and the user. Run the project's own checks (tests / typecheck / build / lint) and re-run the original failing repro; show the passing output. Match the evidence to the KIND of work:\n\
        \x20  - Library/pure logic → the test suite.\n\
        \x20  - A script → run it and check its output.\n\
        \x20  - SERVICE/API behavior (routes, workflows, integrations) → unit tests are NOT sufficient proof. Exercise the changed path AGAINST THE RUNNING SYSTEM: boot it the way the repo documents (AGENTS.md / dev scripts / docker compose — `job_start` for servers and databases), drive the real entry point (curl the endpoint, trigger the workflow, run a scratch script), and show the actual request and response. If running it is genuinely impossible here (missing credentials, external infra), say so EXPLICITLY and name exactly what would prove it — never let unit tests stand in silently for runtime proof.\n\
        \x20  - FRONTEND/UI → you cannot see the page, so start the dev server (`job_start`) and use the `web_check` tool (or the project's e2e/Playwright suite) to confirm it renders with no console errors, failed requests, or uncaught exceptions and shows what it should.\n\
        Independent, expensive lenses (test suite, typecheck, runtime probe) can run as ONE parallel `delegate` wave — each subagent returns a verdict plus the failing lines, never the full log. Never claim done without evidence that fits the work.\n\n\
        RESOLVE — deliver the outcome. For a question or investigation: a direct, evidence-backed answer that names every load-bearing identifier VERBATIM — the exact deploy id, config key, env var, error string, endpoint, metric name, and file:line your evidence rests on. The reader must be able to grep for what you name: 'the pool setting' fails where the exact key PAYMENT_CONNECTION_POOL succeeds; if the evidence is an id or a string, quote it character-for-character in the final report. For a change: SHIP it — commit, push, open or update the PR, and confirm its checks pass (`gh pr checks`; a background job can watch them). Outward actions that tell humans the work is done — resolving review threads, posting PR comments, closing issues — come ONLY AFTER the push: resolving a thread for an unpushed fix misleads its reviewer. Stage ONLY files you deliberately changed — never `git add -A` or `git add .`: builds and codegen can dirty unrelated tracked files (regenerated `*.generated.*` artifacts and the like); leave that churn unstaged and note it in your report. Promote residues before the scratch dies: a durable design → the PR description; new conventions → AGENTS.md; an unfinished frontier → the \"what's left\" of your report. Close with exactly what changed (the files) and the evidence, separating what you checked from what you're assuming. No filler.",
    )
}


/// Build the system prompt for a session rooted at `cwd`.
pub fn system_prompt(cwd: &str, company: Option<&str>, check: Option<&str>) -> String {
    let mut sections = vec![
        identity("a staff software engineer and architect", company),
        working_context(cwd, check),
    ];
    sections.extend(project_docs(cwd));
    sections.extend(skills_index(cwd));
    sections.push(instructions());
    sections.join("\n\n")
}

/// The focused instruction a delegate subagent runs under (see `agent/delegate.rs` for the
/// fan-out mechanics: fresh `run_turn`, same tools minus `delegate`, depth cap 1).
fn subagent_identity() -> String {
    "You are a focused subagent working for the main agent. Do EXACTLY the one sub-task you're given — \
     nothing more, no scope creep. You have the same tools as the main agent (read, search, edit, run \
     commands, background jobs). Work efficiently and, where it applies, verify with hard evidence. \
     END by returning a TIGHT, self-contained result: the answer, or what you changed (the files), plus \
     the evidence (command output, file:line). Quote load-bearing identifiers VERBATIM — exact ids, \
     config keys, env vars, error strings — never a paraphrase: what you don't quote exactly, the main \
     agent cannot cite. If you discovered independent follow-up work outside \
     your sub-task, do NOT do it — end with a `frontier:` line listing it so the main agent can \
     schedule it. Your entire final reply becomes the result handed back to the main agent — no \
     filler, no meta-commentary."
        .to_string()
}

/// System prompt for a delegate subagent: the focused-worker identity plus the SAME working context
/// and project docs the primary agent gets. A subagent that has to rediscover the repo layout from
/// scratch burns its budget on re-derivation — measured live before this landed.
pub fn subagent_system_prompt(cwd: &str, check: Option<&str>) -> String {
    let mut sections = vec![subagent_identity(), working_context(cwd, check)];
    sections.extend(project_docs(cwd));
    sections.extend(skills_index(cwd));
    sections.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_frames_spear_as_a_heuristic_with_a_decidable_delegate_test() {
        let p = system_prompt("/repo", None, None);
        assert!(p.contains("operating heuristic, not a ritual"));
        assert!(p.contains("you can name the exact files"));
        // direct execution is gated on the design being settled, not just files being nameable
        assert!(p.contains("the DESIGN is settled"));
        assert!(p.contains("being able to name the files does NOT mean it's settled"));
        assert!(p.contains("Re-check PLAN as you go"));
        // runtime proof for service changes + selective staging are doctrine, not luck
        assert!(p.contains("AGAINST THE RUNNING SYSTEM"));
        assert!(p.contains("never let unit tests stand in silently for runtime proof"));
        assert!(p.contains("never `git add -A`"));
        // outward actions (thread resolution, PR comments) are sequenced after the push
        assert!(p.contains("ONLY AFTER the push"));
        // the meta-plan loop and its frontier artifact are doctrine
        assert!(p.contains("PROBE"));
        assert!(p.contains(".aj/task/plan.md"));
        assert!(p.contains("never read a file a subagent could summarize"));
        // multi-call round-trip batching is doctrine
        assert!(p.contains("SEVERAL tool calls in ONE response"));
        // the four generating invariants lead the doctrine
        assert!(p.contains("DELEGATE THE READING, NEVER THE DECIDING"));
        assert!(p.contains("Ceremony scales with UNCERTAINTY"));
        // every decision-tree move is named: scouts, judge panel, disjoint shards,
        // assess lens waves, residue promotion
        assert!(p.contains("send SCOUTS"));
        assert!(p.contains("repro before theory"));
        assert!(p.contains("N competing design drafts"));
        assert!(p.contains("DISJOINT file sets"));
        assert!(p.contains("a verdict plus the failing lines"));
        assert!(p.contains("Promote residues"));
        // the hard branch-first rule survives
        assert!(p.contains("STOP and report the git state"));
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

        let p = subagent_system_prompt(root, Some("make check"));
        assert!(p.contains("focused subagent"), "keeps the worker identity");
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
        assert!(!system_prompt(&root, None, None).contains("<skills>"));

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

        let p = system_prompt(&root, None, None);
        assert!(p.contains("<skills>"));
        assert!(p.contains("addressing-pr-feedback — Fetch review threads, fix, push, THEN resolve."));
        assert!(p.contains("(.claude/skills/addressing-pr-feedback/SKILL.md)"));
        assert!(p.contains("- deploy — (no description — read the file)"), "{p}");
        assert!(p.contains("READ its SKILL.md FIRST"));
        // Subagents get the same index.
        assert!(subagent_system_prompt(&root, None).contains("<skills>"));

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
        assert!(!system_prompt(root, None, None).contains("<project_docs>"));

        std::fs::write(dir.join("AGENTS.md"), "# The Map\nBuild with `make x`.").unwrap();
        let p = system_prompt(root, None, None);
        assert!(p.contains("<project_docs>"));
        assert!(p.contains("Build with `make x`."));
        assert!(p.contains("Subdirectories may carry their own AGENTS.md"));

        // Oversized docs are truncated with a pointer, not dropped.
        std::fs::write(dir.join("AGENTS.md"), "x".repeat(30_000)).unwrap();
        let p = system_prompt(root, None, None);
        assert!(p.contains("truncated — read AGENTS.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
