//! Worktree service for the desktop app: inspect a picked directory, list its worktrees, provision a
//! fresh long-running worktree off `origin/<default>`, and remember the last workspace across
//! launches. Provisioned worktrees live in a global store (`~/.agentj/worktrees/<repo>/<branch>`) so
//! the base repository and its parent folder stay pristine.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub is_active: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoScan {
    pub is_git: bool,
    pub base: String,
    pub base_name: String,
    pub default_branch: String,
    pub worktrees: Vec<WorktreeEntry>,
}

/// Run `git -C dir <args>`; stdout (trimmed) on success, stderr on failure.
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn is_git(path: &str) -> bool {
    git(path, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Ok("true")
}

/// The base (main) worktree for any checkout — the first entry of `git worktree list`.
pub fn base_repo(path: &str) -> Option<String> {
    let out = git(path, &["worktree", "list", "--porcelain"]).ok()?;
    out.lines()
        .find_map(|l| l.strip_prefix("worktree "))
        .map(str::to_string)
}

pub fn current_branch(path: &str) -> Option<String> {
    git(path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD")
}

/// The remote's default branch: `origin/HEAD` if set, else the first of origin/main|master, else main.
fn default_branch(base: &str) -> String {
    if let Ok(s) = git(base, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        if let Some(b) = s.strip_prefix("origin/") {
            if !b.is_empty() {
                return b.to_string();
            }
        }
    }
    for cand in ["main", "master"] {
        if git(base, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{cand}")]).is_ok() {
            return cand.to_string();
        }
    }
    "main".to_string()
}

/// Parse `git worktree list --porcelain` into entries; the first block is the main worktree.
fn list(base: &str, open: &[String]) -> Vec<WorktreeEntry> {
    let Ok(out) = git(base, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    let flush = |path: &mut Option<String>, branch: &mut Option<String>, entries: &mut Vec<WorktreeEntry>| {
        if let Some(p) = path.take() {
            let is_active = open.iter().any(|o| o == &p);
            entries.push(WorktreeEntry {
                is_main: entries.is_empty(),
                is_active,
                branch: branch.take(),
                path: p,
            });
        } else {
            *branch = None;
        }
    };
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch, &mut entries);
            path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            branch = Some(b.to_string());
        }
    }
    flush(&mut path, &mut branch, &mut entries);
    entries
}

/// Inspect a picked directory. A non-git directory returns `is_git: false` (not an error) so the UI
/// can say so; only a missing directory is an error.
pub fn inspect(path: &str, open: &[String]) -> Result<RepoScan, String> {
    if !Path::new(path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    if !is_git(path) {
        return Ok(RepoScan {
            is_git: false,
            base: path.to_string(),
            base_name: dir_name(path),
            default_branch: String::new(),
            worktrees: Vec::new(),
        });
    }
    let base = base_repo(path).unwrap_or_else(|| path.to_string());
    Ok(RepoScan {
        is_git: true,
        base_name: dir_name(&base),
        default_branch: default_branch(&base),
        worktrees: list(&base, open),
        base,
    })
}

/// A provisioned worktree plus an optional notice to show first in the session (e.g. when we had to
/// fall back off a local base because the remote default branch wasn't available).
pub struct Provisioned {
    pub path: String,
    pub notice: Option<String>,
}

fn ref_exists(base: &str, r: &str) -> bool {
    git(base, &["rev-parse", "--verify", "--quiet", r]).is_ok()
}

/// The start point for a new worktree, best-first: the remote default branch (current state of the
/// remote), else the local default branch, else the base repo's current branch, else its HEAD. The
/// `Some(notice)` explains any fallback so the UI can surface it.
fn start_point(base: &str) -> Result<(String, Option<String>), String> {
    let _ = git(base, &["fetch", "origin"]); // best-effort; offline uses whatever refs we have
    let def = default_branch(base);
    if ref_exists(base, &format!("refs/remotes/origin/{def}")) {
        return Ok((format!("origin/{def}"), None));
    }
    if ref_exists(base, &format!("refs/heads/{def}")) {
        return Ok((
            def.clone(),
            Some(format!(
                "No origin/{def} on the remote — started this worktree from the local `{def}` branch instead."
            )),
        ));
    }
    if let Some(cur) = current_branch(base) {
        return Ok((
            cur.clone(),
            Some(format!(
                "No remote default branch to start from — started this worktree from `{cur}` (the base repo's current branch)."
            )),
        ));
    }
    if ref_exists(base, "HEAD") {
        return Ok((
            "HEAD".to_string(),
            Some("No remote and no named branch — started this worktree from the base repo's HEAD.".to_string()),
        ));
    }
    Err("this repository has no commits yet — make an initial commit before creating a worktree".into())
}

/// Create a fresh worktree `agentj/<id>` in the global store, branched off the best available start
/// point (see `start_point`). Returns its path and any fallback notice.
pub fn provision(base: &str) -> Result<Provisioned, String> {
    if !is_git(base) {
        return Err(format!("not a git repository: {base}"));
    }
    // An empty repo (no commits) has nothing to branch a worktree from — work in it directly and
    // let agentj make the first commit. Future sessions get their own worktree once it has a commit.
    if !ref_exists(base, "HEAD") {
        return Ok(Provisioned {
            path: base.to_string(),
            notice: Some(
                "This repository has no commits yet — agentj is working directly in it and will make the first commit here. Once it has a commit (and a remote), new sessions get their own worktree.".into(),
            ),
        });
    }
    let (start, notice) = start_point(base)?;
    let id = short_id();
    let branch = format!("agentj/{id}");
    let dir = worktrees_dir()
        .join(slugify(&dir_name(base)))
        .join(format!("agentj-{id}"));
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let path = dir.to_string_lossy().to_string();
    git(base, &["worktree", "add", "-b", &branch, &path, &start])
        .map_err(|e| format!("git worktree add failed (from {start}): {e}"))?;
    Ok(Provisioned { path, notice })
}

// ---- persistence ----------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct DesktopConfig {
    /// Worktrees open as sessions last launch, in tab order.
    #[serde(default)]
    sessions: Vec<String>,
}

fn store_home() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".agentj")
}
fn worktrees_dir() -> PathBuf {
    store_home().join("worktrees")
}
fn config_path() -> PathBuf {
    store_home().join("desktop.json")
}

pub fn remembered_sessions() -> Vec<String> {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str::<DesktopConfig>(&t).ok())
        .map(|c| c.sessions)
        .unwrap_or_default()
}

pub fn remember_sessions(roots: &[String]) {
    let cfg = DesktopConfig { sessions: roots.to_vec() };
    if let Ok(text) = serde_json::to_string_pretty(&cfg) {
        let _ = std::fs::create_dir_all(store_home());
        let _ = std::fs::write(config_path(), text);
    }
}

// ---- helpers --------------------------------------------------------------

pub fn dir_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into())
}

pub fn short_id() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:06x}", (n as u64) & 0xff_ffff)
}

fn slugify(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() { "repo".into() } else { trimmed }
}
