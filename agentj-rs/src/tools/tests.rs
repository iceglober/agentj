use super::*;
use crate::jobs::JobManager;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

fn tools() -> Tools {
    Tools::new(PathBuf::from("."), JobManager::new(".".to_string()), None)
}

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// A `Tools` rooted at a fresh temp dir, so file-mutating tests don't touch the crate tree.
fn temp_tools() -> (Tools, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "agentj-tools-test-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let jm = JobManager::new(dir.to_string_lossy().into_owned());
    (Tools::new(dir.clone(), jm, None), dir)
}

#[tokio::test]
async fn read_file_reaches_global_skills_but_nothing_else_outside_the_repo() {
    let _home = crate::util::HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (t, dir) = temp_tools();
    // Absolute paths outside both the repo and the skills dir stay refused.
    let out = t.call("read_file", &json!({ "path": "/etc/hosts" })).await;
    assert!(!out.ok, "arbitrary absolute reads must stay confined: {}", out.text);
    // Relative escapes stay refused.
    let out = t.call("read_file", &json!({ "path": "../../etc/hosts" })).await;
    assert!(!out.ok);
    // Writes never get the carve-out, even under the skills dir.
    let Ok(home) = std::env::var("HOME") else { return };
    let skills = PathBuf::from(&home).join(".claude/skills");
    let mine = skills.join(format!("agentj-test-{}", std::process::id()));
    fs::create_dir_all(&mine).unwrap();
    let skill_md = mine.join("SKILL.md");
    fs::write(&skill_md, "---\nname: t\n---\nglobal playbook body\n").unwrap();
    let abs = skill_md.to_string_lossy().into_owned();
    let read = t.call("read_file", &json!({ "path": abs })).await;
    let write = t
        .call("write_file", &json!({ "path": abs, "content": "clobbered" }))
        .await;
    let cleanup = fs::remove_dir_all(&mine); // clean before asserting so a failure doesn't leak the dir
    assert!(read.ok, "global SKILL.md must be readable: {}", read.text);
    assert!(read.text.contains("global playbook body"));
    assert!(!write.ok, "the carve-out is READ-only: {}", write.text);
    cleanup.unwrap();
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_scout_scoped_tool_set_refuses_writes_at_dispatch() {
    use crate::agent::AgentType;
    let (base, dir) = temp_tools();
    let scout = base.scoped_to(AgentType::Scout);
    // A scout can read…
    fs::write(dir.join("a.txt"), "x").unwrap();
    assert!(scout.call("read_file", &json!({ "path": "a.txt" })).await.ok);
    // …but writing/editing is refused, naming the type.
    let o = scout.call("write_file", &json!({ "path": "b.txt", "content": "y" })).await;
    assert!(!o.ok && o.text.contains("scout"), "{}", o.text);
    assert!(!scout.call("edit_file", &json!({ "path": "a.txt", "old_string": "x", "new_string": "z" })).await.ok);
    // The executor (default subagent) may write.
    let exec = base.scoped_to(AgentType::Executor);
    assert!(exec.call("write_file", &json!({ "path": "c.txt", "content": "z" })).await.ok);
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn artifact_tools_error_without_a_session_store() {
    // Headless runs have no session; the artifact tools refuse rather than write anywhere.
    let t = tools(); // built with session=None
    let o = t.call("save_artifact", &json!({ "name": "plan", "content": "x" })).await;
    assert!(!o.ok && o.text.contains("no session"), "{}", o.text);
    let o = t.call("read_artifact", &json!({ "name": "plan" })).await;
    assert!(!o.ok && o.text.contains("no session"), "{}", o.text);
}

#[tokio::test]
async fn unknown_tool_reports_not_ok() {
    let o = tools().call("no_such_tool", &json!({})).await;
    assert!(!o.ok);
    assert!(o.text.contains("unknown tool"));
}

#[tokio::test]
async fn missing_required_arg_reports_not_ok() {
    let o = tools().call("read_file", &json!({})).await;
    assert!(!o.ok);
}

#[tokio::test]
async fn reading_a_missing_file_reports_not_ok() {
    let o = tools()
        .call("read_file", &json!({ "path": "definitely-not-here.xyz" }))
        .await;
    assert!(!o.ok);
}

#[tokio::test]
async fn reading_an_existing_file_is_ok() {
    // the crate manifest is always present when tests run from the crate root
    let o = tools().call("read_file", &json!({ "path": "Cargo.toml" })).await;
    assert!(o.ok, "expected ok, got: {}", o.text);
}

#[tokio::test]
async fn list_dir_lists_entries_and_a_missing_path_errors() {
    let (t, dir) = temp_tools();
    fs::write(dir.join("a.txt"), "x").unwrap();
    fs::create_dir_all(dir.join("sub")).unwrap();
    let o = t.call("list_dir", &json!({ "path": "." })).await;
    assert!(o.ok, "expected ok, got: {}", o.text);
    assert!(o.text.contains("a.txt") && o.text.contains("sub"), "entries listed: {}", o.text);

    let o = t.call("list_dir", &json!({ "path": "no-such-dir" })).await;
    assert!(!o.ok);
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn glob_matches_patterns_and_reports_no_hits() {
    let (t, dir) = temp_tools();
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(dir.join("src/lib.rs"), "x").unwrap();
    fs::write(dir.join("src/notes.md"), "x").unwrap();
    let o = t.call("glob", &json!({ "pattern": "**/*.rs" })).await;
    assert!(o.ok, "expected ok, got: {}", o.text);
    assert!(o.text.contains("lib.rs") && !o.text.contains("notes.md"), "rs only: {}", o.text);

    let o = t.call("glob", &json!({ "pattern": "**/*.zig" })).await;
    assert!(o.text.to_ascii_lowercase().contains("no"), "no-match message: {}", o.text);
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn grep_invalid_regex_reports_failure() {
    // An unmatched '(' is invalid for both rg and git grep; the tool must not read the
    // resulting non-1 exit code as "no matches".
    let o = tools().call("grep", &json!({ "pattern": "(" })).await;
    assert!(!o.ok, "expected failure, got ok: {}", o.text);
    assert!(
        o.text.to_ascii_lowercase().contains("fail"),
        "expected a failure message, got: {}",
        o.text
    );
}

#[tokio::test]
async fn grep_empty_path_searches_the_repo() {
    // Empty path must behave like "." (whole repo), not error out.
    let o = tools()
        .call("grep", &json!({ "pattern": "fn ", "path": "" }))
        .await;
    assert!(o.ok, "expected ok, got: {}", o.text);
}

#[tokio::test]
async fn bash_honors_timeout_s() {
    let o = tools()
        .call("bash", &json!({ "command": "sleep 5", "timeout_s": 1 }))
        .await;
    assert!(
        o.text.contains("timed out"),
        "expected a timeout note, got: {}",
        o.text
    );
}

#[tokio::test]
async fn edit_file_replace_all_replaces_every_occurrence() {
    let (t, dir) = temp_tools();
    fs::write(dir.join("f.txt"), "a a a").unwrap();
    let o = t
        .call(
            "edit_file",
            &json!({ "path": "f.txt", "old_string": "a", "new_string": "b", "replace_all": true }),
        )
        .await;
    assert!(o.ok, "expected ok, got: {}", o.text);
    assert!(o.text.contains('3'), "expected a count of 3, got: {}", o.text);
    assert_eq!(fs::read_to_string(dir.join("f.txt")).unwrap(), "b b b");
}

#[tokio::test]
async fn edit_file_not_unique_suggests_replace_all() {
    let (t, dir) = temp_tools();
    fs::write(dir.join("f.txt"), "a a a").unwrap();
    let o = t
        .call(
            "edit_file",
            &json!({ "path": "f.txt", "old_string": "a", "new_string": "b" }),
        )
        .await;
    assert!(!o.ok);
    assert!(
        o.text.contains("replace_all"),
        "expected a replace_all hint, got: {}",
        o.text
    );
}

#[tokio::test]
async fn edit_file_not_found_echoes_the_nearest_match() {
    let (t, dir) = temp_tools();
    fs::write(dir.join("f.txt"), "fn setup() {\n  let a = 1;\n  let b = 2;\n}\n").unwrap();
    // First line matches the file; the rest has drifted → the error carries the real region,
    // so the fix is one resend instead of a read → retry loop.
    let o = t
        .call(
            "edit_file",
            &json!({ "path": "f.txt", "old_string": "fn setup() {\n  let a = 999;", "new_string": "x" }),
        )
        .await;
    assert!(!o.ok);
    assert!(o.text.contains("not found"), "got: {}", o.text);
    assert!(o.text.contains("Nearest match"), "got: {}", o.text);
    assert!(o.text.contains("let a = 1;"), "the real region is echoed: {}", o.text);

    // Nothing anchors → no snippet, plain error.
    let o = t
        .call(
            "edit_file",
            &json!({ "path": "f.txt", "old_string": "nope", "new_string": "x" }),
        )
        .await;
    assert!(!o.ok);
    assert!(!o.text.contains("Nearest match"), "got: {}", o.text);
}

#[tokio::test]
async fn writes_under_aj_create_a_self_ignoring_gitignore() {
    let (t, dir) = temp_tools();
    let o = t
        .call(
            "write_file",
            &json!({ "path": ".aj/task/plan.md", "content": "frontier" }),
        )
        .await;
    assert!(o.ok, "{}", o.text);
    assert_eq!(fs::read_to_string(dir.join(".aj/.gitignore")).unwrap(), "*\n");
    // Ordinary writes don't conjure .aj.
    let (t2, dir2) = temp_tools();
    t2.call("write_file", &json!({ "path": "a.txt", "content": "x" })).await;
    assert!(!dir2.join(".aj").exists());
}

#[tokio::test]
async fn batched_edits_apply_in_order_atomically_and_echo_regions() {
    let (t, dir) = temp_tools();
    fs::write(dir.join("f.rs"), "fn a() {}\nfn b() {}\nfn c() {}\n").unwrap();
    let o = t
        .call(
            "edit_file",
            &json!({ "path": "f.rs", "edits": [
                { "old_string": "fn a() {}", "new_string": "fn a() { one(); }" },
                { "old_string": "fn c() {}", "new_string": "fn c() { three(); }" }
            ]}),
        )
        .await;
    assert!(o.ok, "{}", o.text);
    assert!(o.text.contains("2 replacements"), "{}", o.text);
    assert!(o.text.contains("one();"), "echoes changed region: {}", o.text);
    assert!(o.text.contains("three();"), "echoes second region: {}", o.text);
    let now = fs::read_to_string(dir.join("f.rs")).unwrap();
    assert!(now.contains("one();") && now.contains("three();"));

    // Atomic: a bad op in the middle writes nothing.
    let o = t
        .call(
            "edit_file",
            &json!({ "path": "f.rs", "edits": [
                { "old_string": "fn b() {}", "new_string": "fn b() { two(); }" },
                { "old_string": "DOES NOT EXIST", "new_string": "x" }
            ]}),
        )
        .await;
    assert!(!o.ok);
    assert!(o.text.contains("edit 2/2"), "names the failing op: {}", o.text);
    let now = fs::read_to_string(dir.join("f.rs")).unwrap();
    assert!(!now.contains("two();"), "nothing written on batch failure");
}

#[tokio::test]
async fn edit_lines_replaces_a_range_and_rejects_a_drifted_anchor() {
    let (t, dir) = temp_tools();
    fs::write(dir.join("s.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n").unwrap();
    let o = t
        .call(
            "edit_lines",
            &json!({ "path": "s.ts", "start_line": 2, "end_line": 2, "expect": "const b", "content": "const b = 22;\nconst b2 = 23;" }),
        )
        .await;
    assert!(o.ok, "{}", o.text);
    assert!(o.text.contains("const b = 22;"), "echoes the new region: {}", o.text);
    let now = fs::read_to_string(dir.join("s.ts")).unwrap();
    assert_eq!(now, "const a = 1;\nconst b = 22;\nconst b2 = 23;\nconst c = 3;\n");

    // Drifted anchor: expect doesn't match → error carries the current region to re-anchor from.
    let o = t
        .call(
            "edit_lines",
            &json!({ "path": "s.ts", "start_line": 2, "end_line": 2, "expect": "const zzz", "content": "x" }),
        )
        .await;
    assert!(!o.ok);
    assert!(o.text.contains("const b = 22;"), "shows current region: {}", o.text);
}

#[tokio::test]
async fn edits_fail_stale_when_the_file_changed_since_the_last_read() {
    let (t, dir) = temp_tools();
    fs::write(dir.join("w.txt"), "alpha\n").unwrap();
    let _ = t.call("read_file", &json!({ "path": "w.txt" })).await; // stamps
    fs::write(dir.join("w.txt"), "alpha\nbeta (external change)\n").unwrap();
    let o = t
        .call("edit_file", &json!({ "path": "w.txt", "old_string": "alpha", "new_string": "gamma" }))
        .await;
    assert!(!o.ok);
    assert!(o.text.contains("changed on disk"), "{}", o.text);
    // Re-reading refreshes the stamp; the edit then succeeds.
    let _ = t.call("read_file", &json!({ "path": "w.txt" })).await;
    let o = t
        .call("edit_file", &json!({ "path": "w.txt", "old_string": "alpha", "new_string": "gamma" }))
        .await;
    assert!(o.ok, "{}", o.text);
}
