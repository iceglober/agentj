//! Disposable git worktrees: deterministic scratch checkouts keyed per repo+branch in the OS temp
//! dir. The BRANCH is the durable artifact; the worktree is scratch. Re-entering the same
//! repo+branch lands in the same worktree with its state intact — no registry, no cleanup code
//! (`git worktree prune` handles stale registrations, the OS owns the temp dir).
//!
//! Currently no runtime caller (its former one was removed); retained as a helper for future
//! worktree-backed flows and exercised by its own tests, so the module opts out of dead-code lints.
#![allow(dead_code)]

use crate::exec::run;
use std::path::PathBuf;
use std::time::Duration;

const GIT_TIMEOUT: Duration = Duration::from_secs(60);

/// Create (or re-enter) the worktree for `branch`, returning its path. An existing branch is
/// checked out as-is — a re-entry resumes its own commits; a new branch is created from
/// `base`. Git errors surface verbatim: the caller is assumed git-fluent.
pub async fn ensure(root: &str, branch: &str, base: &str) -> Result<PathBuf, String> {
    let _ = run(&["git", "worktree", "prune"], root, Some(GIT_TIMEOUT)).await;

    let path = path_for(root, branch);
    let path_str = path.to_string_lossy().into_owned();
    if path.exists() {
        // Same path ⇒ same repo+branch by construction; a live checkout here IS the resume case.
        return match git(&["rev-parse", "--abbrev-ref", "HEAD"], &path_str).await {
            Ok(head) if head == branch => Ok(path),
            Ok(head) => Err(format!("{} is occupied by branch `{head}`, not `{branch}` — remove it (`git worktree remove {0}`) or pick another branch", path_str)),
            Err(e) => Err(format!("{path_str} exists but is not a usable worktree: {e}")),
        };
    }

    let local_exists = git(&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], root)
        .await
        .is_ok();
    // A branch that's already In Progress may have its work on a REMOTE branch, not locally — check
    // origin too, so a re-entry resumes that work instead of branching a fresh copy from base and
    // silently discarding it.
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let remote_exists = !local_exists
        && git(&["rev-parse", "--verify", "--quiet", &remote_ref], root)
            .await
            .is_ok();

    let result = if local_exists {
        git(&["worktree", "add", &path_str, branch], root).await
    } else if remote_exists {
        // Create a local branch tracking the existing remote work.
        git(&["worktree", "add", "--track", "-b", branch, &path_str, &format!("origin/{branch}")], root).await
    } else {
        git(&["worktree", "add", "-b", branch, &path_str, base], root).await
    };
    result.map(|_| path)
}

/// One deterministic scratch location per repo+branch: `$TMPDIR/agentj-eng-<repo>-<branch>`.
fn path_for(root: &str, branch: &str) -> PathBuf {
    let repo = PathBuf::from(root)
        .file_name()
        .map(|n| slugify(&n.to_string_lossy()))
        .unwrap_or_else(|| "repo".into());
    std::env::temp_dir().join(format!("agentj-eng-{repo}-{}", slugify(branch)))
}

/// Run one git command in `dir`; Ok(trimmed stdout) on exit 0, Err(verbatim stderr) otherwise.
async fn git(args: &[&str], dir: &str) -> Result<String, String> {
    let mut argv = vec!["git"];
    argv.extend(args);
    match run(&argv, dir, Some(GIT_TIMEOUT)).await {
        Ok(o) if o.exit_code == 0 => Ok(o.stdout.trim().to_string()),
        Ok(o) => {
            let err = o.stderr.trim();
            Err(if err.is_empty() {
                format!("git {} failed (exit {})", args.join(" "), o.exit_code)
            } else {
                err.to_string()
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// `s` reduced to a filesystem-safe slug: ascii alphanumerics kept, everything else `-`, capped.
fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .take(48)
        .collect()
}

/// `s` wrapped in single quotes for `bash -lc`, embedded quotes escaped — the ONLY safe way to
/// pass an arbitrary model-authored brief through a shell.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_repo(tag: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "agentj-worktree-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        for cmd in [
            vec!["git", "init", "-q", "-b", "main"],
            vec!["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "fixture"],
        ] {
            let o = run(&cmd, &root, None).await.unwrap();
            assert_eq!(o.exit_code, 0, "{cmd:?}: {}", o.stderr);
        }
        (dir, root)
    }

    #[tokio::test]
    async fn ensure_creates_a_new_branch_and_reenters_it_on_restart() {
        let (_dir, root) = temp_repo("create").await;
        let wt = ensure(&root, "eng/issue-1", "main").await.unwrap();
        assert!(wt.join(".git").exists(), "worktree checked out");
        assert_eq!(
            git(&["rev-parse", "--abbrev-ref", "HEAD"], &wt.to_string_lossy()).await.unwrap(),
            "eng/issue-1"
        );
        // Restart: same repo+branch resolves to the SAME worktree, state intact.
        let again = ensure(&root, "eng/issue-1", "main").await.unwrap();
        assert_eq!(wt, again);
        let _ = run(&["git", "worktree", "remove", "--force", &wt.to_string_lossy()], &root, None).await;
    }

    #[tokio::test]
    async fn ensure_checks_out_an_existing_branch_instead_of_recreating_it() {
        let (_dir, root) = temp_repo("existing").await;
        git(&["branch", "eng/done-before"], &root).await.unwrap();
        let wt = ensure(&root, "eng/done-before", "main").await.unwrap();
        assert_eq!(
            git(&["rev-parse", "--abbrev-ref", "HEAD"], &wt.to_string_lossy()).await.unwrap(),
            "eng/done-before"
        );
        let _ = run(&["git", "worktree", "remove", "--force", &wt.to_string_lossy()], &root, None).await;
    }

    #[tokio::test]
    async fn ensure_resumes_a_remote_branch_instead_of_branching_from_base() {
        // A child issue already In Progress has its work on origin/<branch>, not locally. ensure
        // must check it out tracking the remote — not create a fresh branch off base and lose it.
        let (_origin_dir, origin) = temp_repo("remote-origin").await;
        // Put distinctive work on a branch in the "remote".
        git(&["checkout", "-q", "-b", "eng/inprogress"], &origin).await.unwrap();
        std::fs::write(std::path::Path::new(&origin).join("child-work.txt"), "wip").unwrap();
        run(&["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], &origin, None).await.unwrap();
        run(&["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "child wip"], &origin, None).await.unwrap();
        git(&["checkout", "-q", "main"], &origin).await.unwrap();

        // A fresh clone: the branch exists only as origin/eng/inprogress.
        let clone_dir = std::env::temp_dir().join(format!("agentj-wt-clone-{}", std::process::id()));
        let clone = clone_dir.to_string_lossy().into_owned();
        run(&["git", "clone", "-q", &origin, &clone], ".", None).await.unwrap();
        assert!(
            git(&["rev-parse", "--verify", "--quiet", "refs/heads/eng/inprogress"], &clone).await.is_err(),
            "branch is not local yet"
        );

        let wt = ensure(&clone, "eng/inprogress", "origin/main").await.unwrap();
        // The worktree carries the remote branch's work, not a fresh copy of base.
        assert!(wt.join("child-work.txt").exists(), "resumed the remote branch's commit");
        assert_eq!(
            git(&["rev-parse", "--abbrev-ref", "HEAD"], &wt.to_string_lossy()).await.unwrap(),
            "eng/inprogress"
        );
        let _ = run(&["git", "worktree", "remove", "--force", &wt.to_string_lossy()], &clone, None).await;
        let _ = std::fs::remove_dir_all(&clone_dir);
    }

    #[tokio::test]
    async fn ensure_surfaces_git_errors_verbatim() {
        let (_dir, root) = temp_repo("badbase").await;
        let err = ensure(&root, "eng/new", "no-such-base").await.unwrap_err();
        assert!(err.contains("no-such-base"), "git's own message survives: {err}");
    }

    #[tokio::test]
    async fn shell_quote_round_trips_through_bash() {
        let hostile = "a 'quoted' brief; $(rm -rf /) `backticks` \"double\" \\ end";
        let cmd = format!("printf %s {}", shell_quote(hostile));
        let o = run(&["bash", "-lc", &cmd], ".", None).await.unwrap();
        assert_eq!(o.exit_code, 0);
        assert_eq!(o.stdout, hostile);
    }

    #[test]
    fn slugify_is_filesystem_safe() {
        assert_eq!(slugify("eng/Issue #42"), "eng-issue--42");
        assert!(slugify(&"x".repeat(100)).len() <= 48);
    }
}
