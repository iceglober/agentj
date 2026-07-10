//! Persistent interactive sessions: a per-run identity (a UUID) with a small store of named
//! artifacts, living OUTSIDE any repo — `~/.config/aj/sessions/<uuid>/` — so nothing agentj
//! remembers can survive inside, or bleed out of, a working tree.
//!
//! This is the fix for stale plans reappearing: the frontier used to be a repo file
//! (`.aj/task/plan.md`), which a `rm -rf` couldn't reliably clear and a fresh run happily re-read.
//! Now a fresh run mints a new session and reads NOBODY else's artifacts; `--resume <uuid>` /
//! `--continue` load a prior one. The model reads and writes artifacts (its plan/frontier, and
//! whatever else it wants to persist) through the `save_artifact` / `read_artifact` tools, which
//! route here — so session state never touches the repo. Headless `--once` runs are unaffected:
//! they keep their in-tree brief (`.aj/task/plan.md`, which can't bleed across a fresh checkout).
//!
//! Deliberately simple (KISS): one directory per session, a `meta.json`, and files under
//! `artifacts/`. "Which sessions belong here" is answered by scanning the metas and matching the
//! canonical worktree path — no separate index to corrupt.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone)]
struct Meta {
    id: String,
    /// Canonical absolute path of the worktree this session was started in — the scan key.
    worktree: String,
    branch: Option<String>,
    created: u64,
    last_active: u64,
}

/// A live handle to one persistent session. `meta.json` on disk is the source of truth; the handle
/// just caches the immutable id/path and rewrites the meta on `touch`.
pub struct Session {
    pub id: String,
    dir: PathBuf,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `~/.config/aj/sessions`, the global store root (consistent with the app config at `~/.config/aj`).
fn store_root() -> io::Result<PathBuf> {
    let home = std::env::var("HOME").map_err(|_| io::Error::other("HOME is not set"))?;
    Ok(Path::new(&home).join(".config").join("aj").join("sessions"))
}

/// Canonicalize a path so the same worktree always keys to the same string (symlinks, `..`, etc.).
fn canonical(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

/// Keep an artifact name to a safe single path segment (no traversal, no separators).
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches(['.', '-']);
    if trimmed.is_empty() { "artifact".to_string() } else { trimmed.to_string() }
}

impl Session {
    fn from_meta(m: Meta, dir: PathBuf) -> Self {
        Session { id: m.id, dir }
    }

    fn meta_path(dir: &Path) -> PathBuf {
        dir.join("meta.json")
    }

    fn read_meta(&self) -> io::Result<Meta> {
        let text = std::fs::read_to_string(Self::meta_path(&self.dir))?;
        serde_json::from_str(&text).map_err(io::Error::other)
    }

    fn write_meta(&self, m: &Meta) -> io::Result<()> {
        std::fs::write(Self::meta_path(&self.dir), serde_json::to_string_pretty(m).map_err(io::Error::other)?)
    }

    /// Mint a brand-new session for `worktree`. Fresh: it owns no artifacts.
    pub fn mint(worktree: &str, branch: Option<String>) -> io::Result<Session> {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = store_root()?.join(&id);
        std::fs::create_dir_all(dir.join("artifacts"))?;
        let m = Meta {
            id: id.clone(),
            worktree: canonical(worktree),
            branch,
            created: now(),
            last_active: now(),
        };
        let s = Session::from_meta(m.clone(), dir);
        s.write_meta(&m)?;
        Ok(s)
    }

    /// Load a session by its UUID.
    pub fn load(id: &str) -> io::Result<Session> {
        let dir = store_root()?.join(id);
        let text = std::fs::read_to_string(Self::meta_path(&dir))?;
        let m: Meta = serde_json::from_str(&text).map_err(io::Error::other)?;
        Ok(Session::from_meta(m, dir))
    }

    /// The most-recently-active session started in `worktree`, if any. Scans the metas — no index.
    pub fn most_recent_for(worktree: &str) -> Option<Session> {
        let want = canonical(worktree);
        let root = store_root().ok()?;
        let mut best: Option<(u64, Session)> = None;
        for entry in std::fs::read_dir(&root).ok()?.flatten() {
            let dir = entry.path();
            let Ok(text) = std::fs::read_to_string(Self::meta_path(&dir)) else { continue };
            let Ok(m) = serde_json::from_str::<Meta>(&text) else { continue };
            if m.worktree != want {
                continue;
            }
            let stamp = m.last_active;
            if best.as_ref().is_none_or(|(t, _)| stamp > *t) {
                best = Some((stamp, Session::from_meta(m, dir)));
            }
        }
        best.map(|(_, s)| s)
    }

    /// Read a named artifact's content, or `None` if it was never saved.
    pub fn read_artifact(&self, name: &str) -> Option<String> {
        let base = self.dir.join("artifacts");
        std::fs::read_to_string(base.join(safe_name(name))).ok()
    }

    /// Save (overwrite) a named artifact and mark the session active. Returns the file's absolute
    /// path so the caller can reference it.
    pub fn save_artifact(&self, name: &str, content: &str) -> io::Result<PathBuf> {
        let dir = self.dir.join("artifacts");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(safe_name(name));
        std::fs::write(&path, content)?;
        self.touch();
        Ok(path)
    }

    /// The on-disk path of an existing artifact, if any.
    fn artifact_path(&self, name: &str) -> Option<PathBuf> {
        let path = self.dir.join("artifacts").join(safe_name(name));
        path.exists().then_some(path)
    }

    /// Apply ordered exact-string replacements (first occurrence each) to an existing artifact,
    /// keeping its format. Returns the new content. Far cheaper than resending the whole artifact —
    /// e.g. flipping one `todos` checkbox instead of rewriting the list.
    pub fn edit_artifact(&self, name: &str, edits: &[(String, String)]) -> Result<String, String> {
        let path = self
            .artifact_path(name)
            .ok_or_else(|| format!("no artifact `{name}` in this session — save it first"))?;
        let mut content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        for (old, new) in edits {
            if content.contains(old.as_str()) {
                content = content.replacen(old, new, 1);
            } else {
                let clip: String = old.chars().take(60).collect();
                return Err(format!("edit target not found in `{name}`: {clip:?}"));
            }
        }
        std::fs::write(&path, &content).map_err(|e| e.to_string())?;
        self.touch();
        Ok(content)
    }

    /// Bump `last_active` so `--continue` finds the right session. Best-effort.
    pub fn touch(&self) {
        if let Ok(mut m) = self.read_meta() {
            m.last_active = now();
            let _ = self.write_meta(&m);
        }
    }

    #[cfg(test)]
    fn force_last_active(&self, stamp: u64) {
        if let Ok(mut m) = self.read_meta() {
            m.last_active = stamp;
            let _ = self.write_meta(&m);
        }
    }

    /// A session rooted at an explicit directory, bypassing the HOME-based store — for tests that
    /// want an artifact store without touching the process-global `HOME`.
    #[cfg(test)]
    pub(crate) fn at_dir(dir: PathBuf) -> Session {
        std::fs::create_dir_all(dir.join("artifacts")).unwrap();
        Session { id: "test-session".into(), dir }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HOME is process-global, so the HOME-mutating tests must not run concurrently.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Point HOME at a fresh temp dir so the store is isolated per test; holds the serialization
    /// lock for the test's lifetime.
    struct TempHome {
        _dir: PathBuf,
        prev: Option<String>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }
    impl TempHome {
        fn new(tag: &str) -> Self {
            let guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let dir = std::env::temp_dir().join(format!("agentj-sess-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let prev = std::env::var("HOME").ok();
            std::env::set_var("HOME", &dir);
            TempHome { _dir: dir, prev, _guard: guard }
        }
    }
    impl Drop for TempHome {
        fn drop(&mut self) {
            match &self.prev {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
            let _ = std::fs::remove_dir_all(&self._dir);
        }
    }

    #[test]
    fn mint_load_and_artifacts_round_trip() {
        let _home = TempHome::new("rt");
        let wt = std::env::temp_dir().to_string_lossy().into_owned();
        let s = Session::mint(&wt, Some("main".into())).unwrap();
        assert!(!s.id.is_empty());
        assert!(s.read_artifact("plan").is_none(), "a fresh session owns no artifacts");

        s.save_artifact("plan", "# do the thing\n- pending: build it").unwrap();
        let reloaded = Session::load(&s.id).unwrap();
        assert_eq!(
            reloaded.read_artifact("plan").as_deref(),
            Some("# do the thing\n- pending: build it"),
            "artifact persists across load"
        );
    }

    #[test]
    fn artifacts_round_trip_and_overwrite_in_place() {
        let _home = TempHome::new("fmt");
        let wt = std::env::temp_dir().to_string_lossy().into_owned();
        let s = Session::mint(&wt, None).unwrap();

        let path = s.save_artifact("todos", "- [ ] a").unwrap();
        assert!(path.to_string_lossy().ends_with("todos"), "stored under the bare name");
        assert_eq!(s.read_artifact("todos").as_deref(), Some("- [ ] a"));

        // Re-saving the same name overwrites in place.
        s.save_artifact("todos", "- [x] a").unwrap();
        assert_eq!(s.read_artifact("todos").as_deref(), Some("- [x] a"));
    }

    #[test]
    fn most_recent_for_matches_the_worktree_and_picks_the_latest() {
        let _home = TempHome::new("recent");
        let a = std::env::temp_dir().join("wt-a").to_string_lossy().into_owned();
        let b = std::env::temp_dir().join("wt-b").to_string_lossy().into_owned();
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let s1 = Session::mint(&a, None).unwrap();
        let s2 = Session::mint(&a, None).unwrap();
        let _other = Session::mint(&b, None).unwrap();
        // Force an unambiguous ordering (wall-clock seconds would tie in a fast test).
        s1.force_last_active(100);
        s2.force_last_active(200);

        let found = Session::most_recent_for(&a).expect("a session for worktree a");
        assert_eq!(found.id, s2.id, "the latest session for the worktree wins");
        assert_ne!(found.id, s1.id);

        // A worktree with no sessions resolves to nothing (a fresh place stays fresh).
        let c = std::env::temp_dir().join("wt-c").to_string_lossy().into_owned();
        std::fs::create_dir_all(&c).unwrap();
        assert!(Session::most_recent_for(&c).is_none());
    }

    #[test]
    fn artifact_names_are_sanitized_to_one_safe_segment() {
        assert_eq!(safe_name("plan"), "plan");
        assert_eq!(safe_name("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_name("a/b\\c"), "a-b-c");
        assert_eq!(safe_name("..."), "artifact");
    }
}
