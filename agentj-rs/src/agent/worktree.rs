//! Delegation-owned git worktree leases. Each lease creates an isolated checkout on a unique branch
//! from the caller's current `HEAD`, and finalization only cleans up when the lane is provably
//! unchanged.
//!
//! This file lands in Wave 1 before the delegate integration exists.

use crate::exec::run;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const GIT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub(crate) struct WorktreeLease {
    source_root: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) branch: String,
    pub(crate) base: String,
    finalized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FinalizeResult {
    pub(crate) root: PathBuf,
    pub(crate) branch: String,
    pub(crate) base: String,
    pub(crate) head: Option<String>,
    pub(crate) preserved: bool,
    pub(crate) detail: String,
}

impl FinalizeResult {
    pub(crate) fn parent_note(&self) -> String {
        let status = if self.preserved {
            "preserved"
        } else {
            "cleaned"
        };
        format!(
            "isolated worktree {status}: `{}` at `{}` (base {}, {})",
            self.branch,
            self.root.display(),
            short_oid(&self.base),
            self.detail
        )
    }
}

impl WorktreeLease {
    /// Create a unique branch + linked worktree from `root`'s current `HEAD`.
    pub(crate) async fn new(root: &str) -> Result<Self, String> {
        let source_root = validate_root(root).await?;
        let source_root_str = source_root.to_string_lossy().into_owned();
        let base = git_stdout(&["rev-parse", "HEAD"], &source_root_str).await?;

        let repo_slug = source_root
            .file_name()
            .map(|name| slugify(&name.to_string_lossy()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "repo".to_string());
        let base_short = short_oid(&base);
        let namespace = namespace_dir()?;

        for _ in 0..8 {
            let token = Uuid::new_v4().simple().to_string();
            let branch = format!("agentj/subagent/{base_short}-{}", &token[..12]);
            let root = namespace.join(format!("{repo_slug}-{base_short}-{}", &token[..12]));
            let root_str = root.to_string_lossy().into_owned();
            if root.exists() {
                continue;
            }
            let args = [
                "worktree",
                "add",
                "-b",
                branch.as_str(),
                root_str.as_str(),
                base.as_str(),
            ];
            git_ok(&args, &source_root_str).await?;
            return Ok(Self {
                source_root,
                root,
                branch,
                base,
                finalized: false,
            });
        }

        Err("failed to allocate a unique subagent worktree after 8 attempts".to_string())
    }

    /// Preserve the lane without any git inspection or cleanup. Callers use this when some external
    /// condition makes cleanup unsafe, e.g. a shared background job may still be using the worktree.
    pub(crate) fn preserve(mut self, detail: impl Into<String>) -> FinalizeResult {
        self.finalized = true;
        self.preserved(None, detail.into())
    }

    /// Clean up only when the lane is conclusively unchanged. Any dirt, new commits, command
    /// failure, or uncertainty preserves the lane and reports why.
    pub(crate) async fn finalize(mut self) -> FinalizeResult {
        self.finalized = true;

        let source_root = self.source_root.to_string_lossy().into_owned();
        let worktree_root = self.root.to_string_lossy().into_owned();

        let dirty = match git_stdout(
            &["status", "--porcelain", "--untracked-files=normal"],
            &worktree_root,
        )
        .await
        {
            Ok(stdout) => !stdout.is_empty(),
            Err(err) => return self.preserved(None, format!("could not inspect dirt: {err}")),
        };

        let head = match git_stdout(&["rev-parse", "HEAD"], &worktree_root).await {
            Ok(head) => head,
            Err(err) => {
                return self.preserved(None, format!("could not resolve worktree HEAD: {err}"));
            }
        };

        if dirty {
            return self.preserved(Some(head), "dirty working tree".to_string());
        }
        if head != self.base {
            return self.preserved(
                Some(head.clone()),
                format!(
                    "HEAD {} differs from base {}",
                    short_oid(&head),
                    short_oid(&self.base)
                ),
            );
        }

        let root_path = self.root.to_string_lossy().into_owned();
        let remove_args = ["worktree", "remove", root_path.as_str()];
        if let Err(err) = git_ok(&remove_args, &source_root).await {
            return self.preserved(
                Some(head),
                format!("cleanup uncertain: git worktree remove failed: {err}"),
            );
        }

        let delete_args = ["branch", "-D", self.branch.as_str()];
        match git_ok(&delete_args, &source_root).await {
            Ok(()) => FinalizeResult {
                root: self.root,
                branch: self.branch,
                base: self.base,
                head: Some(head),
                preserved: false,
                detail: "unchanged lane removed".to_string(),
            },
            Err(err) => FinalizeResult {
                root: self.root,
                branch: self.branch,
                base: self.base,
                head: Some(head),
                preserved: true,
                detail: format!(
                    "cleanup uncertain: worktree removed but branch deletion failed: {err}"
                ),
            },
        }
    }

    fn preserved(&self, head: Option<String>, detail: String) -> FinalizeResult {
        FinalizeResult {
            root: self.root.clone(),
            branch: self.branch.clone(),
            base: self.base.clone(),
            head,
            preserved: true,
            detail,
        }
    }
}

fn namespace_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir()
        .join("agentj-subagent-worktrees")
        .join(std::process::id().to_string());
    fs::create_dir_all(&dir).map_err(|err| {
        format!(
            "failed to create subagent worktree namespace `{}`: {err}",
            dir.display()
        )
    })?;
    Ok(dir)
}

async fn validate_root(root: &str) -> Result<PathBuf, String> {
    let given = Path::new(root);
    if !given.is_dir() {
        return Err(format!("`{root}` is not a directory"));
    }
    let canonical =
        fs::canonicalize(given).map_err(|err| format!("failed to resolve `{root}`: {err}"))?;
    let canonical_str = canonical.to_string_lossy().into_owned();

    let top_level = git_stdout(&["rev-parse", "--show-toplevel"], &canonical_str)
        .await
        .map_err(|err| format!("`{root}` is not a git worktree root: {err}"))?;
    let top_level = fs::canonicalize(&top_level)
        .map_err(|err| format!("failed to canonicalize git root `{top_level}`: {err}"))?;

    if top_level != canonical {
        return Err(format!(
            "`{root}` is inside git worktree `{}` but is not the worktree root",
            top_level.display()
        ));
    }

    let _ = git_stdout(&["rev-parse", "HEAD"], &canonical_str)
        .await
        .map_err(|err| format!("`{root}` does not have a resolvable HEAD: {err}"))?;
    Ok(canonical)
}

async fn git_stdout(args: &[&str], cwd: &str) -> Result<String, String> {
    let mut argv = vec!["git"];
    argv.extend_from_slice(args);
    match run(&argv, cwd, Some(GIT_TIMEOUT)).await {
        Ok(output) if output.exit_code == 0 => Ok(output.stdout.trim().to_string()),
        Ok(output) => {
            let stderr = output.stderr.trim();
            let stdout = output.stdout.trim();
            let msg = if !stderr.is_empty() {
                stderr.to_string()
            } else if !stdout.is_empty() {
                stdout.to_string()
            } else if output.timed_out {
                format!("timed out running `git {}`", args.join(" "))
            } else {
                format!("`git {}` exited {}", args.join(" "), output.exit_code)
            };
            Err(msg)
        }
        Err(err) => Err(err.to_string()),
    }
}

async fn git_ok(args: &[&str], cwd: &str) -> Result<(), String> {
    git_stdout(args, cwd).await.map(|_| ())
}

fn short_oid(oid: &str) -> &str {
    &oid[..oid.len().min(12)]
}

fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(48)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_repo(tag: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "agentj-agent-worktree-test-{tag}-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        for cmd in [
            vec!["git", "init", "-q", "-b", "main"],
            vec![
                "git",
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        ] {
            let output = run(&cmd, &root, None).await.unwrap();
            assert_eq!(output.exit_code, 0, "{cmd:?}: {}", output.stderr);
        }
        (dir, root)
    }

    async fn branch_exists(root: &str, branch: &str) -> bool {
        git_ok(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
            root,
        )
        .await
        .is_ok()
    }

    async fn cleanup_preserved(root: &str, result: &FinalizeResult) {
        if result.root.exists() {
            let root_path = result.root.to_string_lossy().into_owned();
            let remove = ["git", "worktree", "remove", "--force", root_path.as_str()];
            let output = run(&remove, root, None).await.unwrap();
            assert_eq!(output.exit_code, 0, "{}", output.stderr);
        }
        let delete = ["git", "branch", "-D", result.branch.as_str()];
        let output = run(&delete, root, None).await.unwrap();
        assert_eq!(output.exit_code, 0, "{}", output.stderr);
    }

    async fn commit_file(root: &Path, name: &str, contents: &str, message: &str) {
        fs::write(root.join(name), contents).unwrap();
        let root_str = root.to_string_lossy().into_owned();
        let add = run(&["git", "add", name], &root_str, None).await.unwrap();
        assert_eq!(add.exit_code, 0, "{}", add.stderr);
        let commit = run(
            &[
                "git",
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                message,
            ],
            &root_str,
            None,
        )
        .await
        .unwrap();
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr);
    }

    #[tokio::test]
    async fn rejects_a_non_git_root() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-agent-worktree-nongit-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();

        let err = WorktreeLease::new(&dir.to_string_lossy())
            .await
            .unwrap_err();
        assert!(err.contains("git worktree root"), "{err}");

        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn creates_two_unique_lanes_from_the_same_base() {
        let (_dir, root) = temp_repo("unique").await;

        let first = WorktreeLease::new(&root).await.unwrap();
        let second = WorktreeLease::new(&root).await.unwrap();

        assert_ne!(first.branch, second.branch);
        assert_ne!(first.root, second.root);
        assert_eq!(first.base, second.base);
        let namespace = namespace_dir().unwrap();
        assert!(first.root.starts_with(&namespace));
        assert!(second.root.starts_with(&namespace));

        let first_result = first.finalize().await;
        let second_result = second.finalize().await;
        assert!(!first_result.preserved, "{}", first_result.parent_note());
        assert!(!second_result.preserved, "{}", second_result.parent_note());
        assert!(!first_result.root.exists());
        assert!(!second_result.root.exists());
    }

    #[tokio::test]
    async fn finalize_removes_an_unchanged_lane() {
        let (_dir, root) = temp_repo("clean").await;
        let lease = WorktreeLease::new(&root).await.unwrap();
        let branch = lease.branch.clone();

        let result = lease.finalize().await;

        assert!(!result.preserved, "{}", result.parent_note());
        assert!(!result.root.exists(), "clean lane should be removed");
        assert!(
            !branch_exists(&root, &branch).await,
            "clean branch should be deleted"
        );
        assert!(result.parent_note().contains("cleaned"));
    }

    #[tokio::test]
    async fn finalize_preserves_a_dirty_lane() {
        let (_dir, root) = temp_repo("dirty").await;
        let lease = WorktreeLease::new(&root).await.unwrap();
        fs::write(lease.root.join("dirty.txt"), "wip").unwrap();

        let result = lease.finalize().await;

        assert!(result.preserved, "{}", result.parent_note());
        assert!(result.root.exists(), "dirty lane must be kept");
        assert!(branch_exists(&root, &result.branch).await);
        assert_eq!(result.head.as_deref(), Some(result.base.as_str()));
        assert!(result.detail.contains("dirty"), "{}", result.detail);

        cleanup_preserved(&root, &result).await;
    }

    #[tokio::test]
    async fn finalize_preserves_a_lane_with_committed_work() {
        let (_dir, root) = temp_repo("committed").await;
        let lease = WorktreeLease::new(&root).await.unwrap();
        commit_file(&lease.root, "committed.txt", "done", "lane work").await;

        let result = lease.finalize().await;

        assert!(result.preserved, "{}", result.parent_note());
        assert!(result.root.exists(), "committed lane must be kept");
        assert!(branch_exists(&root, &result.branch).await);
        assert_ne!(result.head.as_deref(), Some(result.base.as_str()));
        assert!(
            result.detail.contains("differs from base"),
            "{}",
            result.detail
        );

        cleanup_preserved(&root, &result).await;
    }

    #[tokio::test]
    async fn explicit_preserve_skips_cleanup() {
        let (_dir, root) = temp_repo("explicit-preserve").await;
        let lease = WorktreeLease::new(&root).await.unwrap();

        let result = lease.preserve("live shared background job");

        assert!(result.preserved, "{}", result.parent_note());
        assert!(
            result.root.exists(),
            "explicit preserve must keep the worktree"
        );
        assert!(branch_exists(&root, &result.branch).await);
        assert_eq!(
            result.head, None,
            "explicit preserve should not inspect HEAD"
        );
        assert_eq!(result.detail, "live shared background job");

        cleanup_preserved(&root, &result).await;
    }

    #[test]
    fn parent_note_is_concise_and_informative() {
        let result = FinalizeResult {
            root: PathBuf::from("/tmp/example"),
            branch: "agentj/subagent/abc".to_string(),
            base: "0123456789abcdef".to_string(),
            head: Some("0123456789abcdef".to_string()),
            preserved: true,
            detail: "dirty working tree".to_string(),
        };

        assert_eq!(
            result.parent_note(),
            "isolated worktree preserved: `agentj/subagent/abc` at `/tmp/example` (base 0123456789ab, dirty working tree)"
        );
    }
}
