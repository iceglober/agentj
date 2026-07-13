//! Deterministic worktree lifecycle hooks: repo-committed scripts under `.aj/hooks/` that the
//! harness runs AUTOMATICALLY — the model never debugs pnpm; the environment is provisioned by
//! infrastructure, not per-conversation reasoning. The catalog of hook points lives here
//! ([`HookKind`]) so every frontend (CLI, desktop UI) renders the same set.
//!
//! Two cadences:
//!  - `worktree_new` — once per (worktree, script content). The stamp lives OUTSIDE the repo
//!    (`~/.config/aj/workspaces/<key>/`) so it never dirties a diff, and it embeds the script's
//!    content hash, so editing the hook re-runs it everywhere. A FAILED run is not stamped: the
//!    next session retries (transient network failures heal themselves).
//!  - `session_start` — every time a session opens in the worktree (dev services, env refresh).
//!
//! Trust model: hooks are repo code executed on open, the same standing `.mcp.json` already has
//! (repo-configured servers auto-connect and run). agentj's philosophy is auto-permission inside
//! the repo the user chose to open.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Hard cap on a hook run — a hung installer must not wedge startup forever.
const HOOK_TIMEOUT: Duration = Duration::from_secs(600);

/// A hook point the harness supports. The single source of truth for names, cadence, and
/// descriptions — frontends render their pickers from this.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HookKind {
    /// Provision a worktree: runs once per (worktree, script version), before the model acts.
    WorktreeNew,
    /// Runs on EVERY session open in the worktree (after worktree_new when both fire).
    SessionStart,
}

impl HookKind {
    pub fn all() -> &'static [HookKind] {
        &[HookKind::WorktreeNew, HookKind::SessionStart]
    }

    /// The script's file name under `.aj/hooks/`.
    pub fn name(self) -> &'static str {
        match self {
            HookKind::WorktreeNew => "worktree_new",
            HookKind::SessionStart => "session_start",
        }
    }

    /// Intentional compatibility member — kept public so frontends can parse hook names
    /// from config/CLI without coupling to the enum representation.
    #[allow(dead_code)]
    pub fn parse(s: &str) -> Option<HookKind> {
        HookKind::all().iter().copied().find(|k| k.name() == s)
    }

    /// One line for pickers/status rows.
    /// Intentional compatibility member — kept public so frontends can render hook
    /// descriptions without coupling to the enum representation.
    #[allow(dead_code)]
    pub fn description(self) -> &'static str {
        match self {
            HookKind::WorktreeNew => {
                "Provision the environment (installs, env files) — runs once per worktree, \
                 and again whenever the script changes"
            }
            HookKind::SessionStart => {
                "Runs every time a session opens in this worktree (start services, refresh state)"
            }
        }
    }

    /// Whether runs are stamped (run-once) or repeat every session.
    fn stamped(self) -> bool {
        matches!(self, HookKind::WorktreeNew)
    }

    /// The script path for a worktree.
    pub fn script_path(self, root: &str) -> PathBuf {
        Path::new(root).join(".aj").join("hooks").join(self.name())
    }
}

/// What a hook run produced, for the frontend to surface (CLI print / TUI notice / desktop notice).
pub struct HookRun {
    /// Intentional compatibility member — kept public so frontends can inspect hook
    /// success without coupling to the summary string format.
    #[allow(dead_code)]
    pub ok: bool,
    pub summary: String,
}

/// FNV-1a 64 — tiny, dependency-free, stable across runs. Keys stamp files and workspace dirs.
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// `<dirname>-<hash8>` for the canonical worktree path — readable in `ls`, collision-keyed by the
/// full path.
fn workspace_key(root: &str) -> String {
    let canonical = std::fs::canonicalize(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root.to_string());
    let dirname = Path::new(&canonical)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".to_string());
    let safe: String = dirname
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    format!("{safe}-{:08x}", fnv1a(&canonical) as u32)
}

/// The run-once stamp for this (worktree, hook, script content): outside the repo, hash in the name.
fn stamp_path(root: &str, kind: HookKind, script_hash: u64) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        Path::new(&home)
            .join(".config")
            .join("aj")
            .join("workspaces")
            .join(workspace_key(root))
            .join(format!("{}.{script_hash:016x}", kind.name())),
    )
}

/// The last few non-empty output lines, for a failure summary the user can act on.
fn tail(text: &str, lines: usize, cap: usize) -> String {
    let picked: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = picked.len().saturating_sub(lines);
    picked[start..].join(" · ").chars().take(cap).collect()
}

/// Run one hook for `root` if its script exists (and, for stamped kinds, hasn't run for this
/// script version). `None` = nothing happened. Best-effort by design: a failure is reported and
/// (for stamped kinds) retried next session, never fatal — a broken hook must not brick the agent.
pub async fn run_hook(root: &str, kind: HookKind) -> Option<HookRun> {
    let script = kind.script_path(root);
    let content = std::fs::read_to_string(&script).ok()?;
    let stamp = kind
        .stamped()
        .then(|| stamp_path(root, kind, fnv1a(&content)))
        .flatten();
    if kind.stamped() && stamp.as_ref().is_none_or(|s| s.exists()) {
        // Already ran for this script version — or no HOME to stamp in, where running every
        // session would violate the run-once contract, so we don't run at all.
        return None;
    }
    let run = tokio::time::timeout(
        HOOK_TIMEOUT,
        tokio::process::Command::new("bash")
            .arg(&script)
            .current_dir(root)
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await;
    let name = kind.name();
    Some(match run {
        Err(_) => HookRun {
            ok: false,
            summary: format!("{name} hook timed out after {}s", HOOK_TIMEOUT.as_secs()),
        },
        Ok(Err(e)) => HookRun {
            ok: false,
            summary: format!("{name} hook could not start: {e}"),
        },
        Ok(Ok(out)) => {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if out.status.success() {
                if let Some(s) = &stamp {
                    if let Some(dir) = s.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(s, b"");
                }
                HookRun {
                    ok: true,
                    summary: format!("{name} hook: ok ({})", tail(&combined, 1, 120)),
                }
            } else {
                let retry = if kind.stamped() {
                    " — will retry next session"
                } else {
                    ""
                };
                HookRun {
                    ok: false,
                    summary: format!(
                        "{name} hook FAILED (exit {}): {}{retry}",
                        out.status.code().unwrap_or(-1),
                        tail(&combined, 3, 300)
                    ),
                }
            }
        }
    })
}

/// Run every startup hook for `root` in catalog order (worktree_new provisions before
/// session_start uses the environment). One call for every frontend's session-open path.
pub async fn run_startup(root: &str) -> Vec<HookRun> {
    let mut out = Vec::new();
    for kind in HookKind::all() {
        if let Some(run) = run_hook(root, *kind).await {
            out.push(run);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_worktree(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentj-hook-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join(".aj/hooks")).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        // Remove the stamp dir keyed to this worktree, then the worktree itself.
        if let Some(stamp) = stamp_path(&dir.to_string_lossy(), HookKind::WorktreeNew, 0) {
            if let Some(ws) = stamp.parent() {
                let _ = std::fs::remove_dir_all(ws);
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// HOME_LOCK serializes HOME mutation across async tests; the guard is held across
    /// await points intentionally — replacing the global test lock is out of scope.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn worktree_new_runs_once_per_script_version_and_reruns_when_edited() {
        let _home = crate::util::HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if std::env::var("HOME").is_err() {
            return;
        }
        let dir = temp_worktree("once");
        let root = dir.to_string_lossy().into_owned();
        // No hook file → nothing happens.
        std::fs::remove_dir_all(dir.join(".aj/hooks")).unwrap();
        assert!(run_hook(&root, HookKind::WorktreeNew).await.is_none());
        std::fs::create_dir_all(dir.join(".aj/hooks")).unwrap();

        let script = dir.join(".aj/hooks/worktree_new");
        std::fs::write(&script, "echo provisioning >> hook.log\necho done\n").unwrap();
        let first = run_hook(&root, HookKind::WorktreeNew)
            .await
            .expect("first run executes");
        assert!(first.ok, "{}", first.summary);
        assert!(
            first.summary.contains("done"),
            "summary carries the output tail: {}",
            first.summary
        );
        assert!(
            run_hook(&root, HookKind::WorktreeNew).await.is_none(),
            "same script is stamped — no rerun"
        );
        let log = std::fs::read_to_string(dir.join("hook.log")).unwrap();
        assert_eq!(log.lines().count(), 1, "the hook body ran exactly once");

        // Editing the script re-runs it (new content hash, new stamp).
        std::fs::write(&script, "echo provisioning-v2 >> hook.log\n").unwrap();
        let second = run_hook(&root, HookKind::WorktreeNew)
            .await
            .expect("edited script runs again");
        assert!(second.ok);
        let log = std::fs::read_to_string(dir.join("hook.log")).unwrap();
        assert_eq!(log.lines().count(), 2);
        cleanup(&dir);
    }

    /// HOME_LOCK serializes HOME mutation across async tests; the guard is held across
    /// await points intentionally — replacing the global test lock is out of scope.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn session_start_runs_every_time_and_startup_orders_both() {
        let _home = crate::util::HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if std::env::var("HOME").is_err() {
            return;
        }
        let dir = temp_worktree("every");
        let root = dir.to_string_lossy().into_owned();
        std::fs::write(
            dir.join(".aj/hooks/worktree_new"),
            "echo new >> order.log\n",
        )
        .unwrap();
        std::fs::write(
            dir.join(".aj/hooks/session_start"),
            "echo start >> order.log\n",
        )
        .unwrap();

        let runs = run_startup(&root).await;
        assert_eq!(runs.len(), 2, "both hooks fire on a fresh worktree");
        let log = std::fs::read_to_string(dir.join("order.log")).unwrap();
        assert_eq!(
            log, "new\nstart\n",
            "worktree_new provisions BEFORE session_start"
        );

        // Second session: worktree_new is stamped, session_start repeats.
        let runs = run_startup(&root).await;
        assert_eq!(runs.len(), 1);
        assert!(
            runs[0].summary.starts_with("session_start"),
            "{}",
            runs[0].summary
        );
        let log = std::fs::read_to_string(dir.join("order.log")).unwrap();
        assert_eq!(log, "new\nstart\nstart\n");
        cleanup(&dir);
    }

    /// HOME_LOCK serializes HOME mutation across async tests; the guard is held across
    /// await points intentionally so a failed worktree_new hook still retries under
    /// the same process-global HOME isolation.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn failed_stamped_hook_is_reported_not_stamped_and_retries() {
        let _home = crate::util::HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if std::env::var("HOME").is_err() {
            return;
        }
        let dir = temp_worktree("fail");
        let root = dir.to_string_lossy().into_owned();
        std::fs::write(
            dir.join(".aj/hooks/worktree_new"),
            "echo installing\necho 'network unreachable' >&2\nexit 7\n",
        )
        .unwrap();
        let run = run_hook(&root, HookKind::WorktreeNew)
            .await
            .expect("hook ran");
        assert!(!run.ok);
        assert!(run.summary.contains("exit 7"), "{}", run.summary);
        assert!(
            run.summary.contains("network unreachable"),
            "failure carries stderr: {}",
            run.summary
        );
        assert!(run.summary.contains("retry"), "{}", run.summary);
        // Not stamped → a later session tries again.
        assert!(
            run_hook(&root, HookKind::WorktreeNew).await.is_some(),
            "failed hooks retry"
        );
        cleanup(&dir);
    }

    #[test]
    fn kind_catalog_parses_its_own_names() {
        for k in HookKind::all() {
            assert_eq!(HookKind::parse(k.name()), Some(*k));
            assert!(!k.description().is_empty());
        }
        assert_eq!(HookKind::parse("nonsense"), None);
    }
}
