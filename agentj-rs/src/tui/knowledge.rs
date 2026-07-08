//! The knowledge index behind `/init` and `/knowledge`: a hash snapshot of the repo's tracked files
//! (`.aj/knowledge.json`), plus the directive prompts that drive the orchestrated documentation
//! turns. Hashing and diffing are deterministic Rust — the model never guesses what changed; it gets
//! handed the exact added/modified/removed lists.

use crate::exec;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

pub const INDEX_PATH: &str = ".aj/knowledge.json";
const CONFIG_PATH: &str = ".aj/aj.json";
/// Cap per-bucket path listings in the /knowledge directive so a huge refactor doesn't blow the
/// prompt; the counts always state the real totals.
const MAX_LISTED: usize = 80;

#[derive(Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    /// Relative path → FNV-1a 64 hex digest of the file contents.
    pub files: BTreeMap<String, String>,
}

/// FNV-1a 64-bit, hex-encoded. Not cryptographic — this is change detection, where the worst a
/// collision costs is one missed doc-review hint.
pub fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Tracked + untracked-but-not-ignored files relative to `root` (same lens as the glob tool), with
/// `.aj/` internals excluded — the index shouldn't index itself.
pub async fn tracked_files(root: &str) -> anyhow::Result<Vec<String>> {
    // core.quotepath=off keeps non-ASCII paths verbatim; git otherwise octal-escapes them, which would
    // corrupt the manifest keys and the change lists handed to the model.
    let o = exec::run(
        &[
            "git",
            "-c",
            "core.quotepath=off",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        root,
        None,
    )
    .await?;
    if o.exit_code != 0 {
        anyhow::bail!("git ls-files failed — the knowledge index needs a git repository");
    }
    Ok(o.stdout
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with(".aj/"))
        .map(String::from)
        .collect())
}

/// Hash every listed file that is still readable (racing deletions just drop out).
pub fn hash_files(root: &str, files: &[String]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for f in files {
        if let Ok(bytes) = std::fs::read(Path::new(root).join(f)) {
            map.insert(f.clone(), fnv1a_hex(&bytes));
        }
    }
    map
}

/// Hash the current tree and write the manifest. Returns how many files were indexed.
pub async fn snapshot(root: &str) -> anyhow::Result<usize> {
    let files = tracked_files(root).await?;
    let manifest = Manifest {
        version: 1,
        files: hash_files(root, &files),
    };
    let path = Path::new(root).join(INDEX_PATH);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&manifest)?)?;
    Ok(manifest.files.len())
}

pub fn load_manifest(root: &str) -> Option<Manifest> {
    let s = std::fs::read_to_string(Path::new(root).join(INDEX_PATH)).ok()?;
    serde_json::from_str(&s).ok()
}

/// Write a boilerplate `.aj/aj.json` when none exists (never overwrites). Returns whether a file
/// was created. Keys must stay valid `AppConfig` fields — it rejects unknown keys on load.
pub fn write_boilerplate_config(root: &str, model_id: &str) -> anyhow::Result<bool> {
    let path = Path::new(root).join(CONFIG_PATH);
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(&serde_json::json!({ "model": model_id }))?;
    std::fs::write(&path, body + "\n")?;
    Ok(true)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.removed.is_empty()
    }
}

/// What changed between the stored manifest and the current tree.
pub fn diff_manifest(
    old: &BTreeMap<String, String>,
    current: &BTreeMap<String, String>,
) -> Changes {
    let mut c = Changes::default();
    for (path, hash) in current {
        match old.get(path) {
            None => c.added.push(path.clone()),
            Some(h) if h != hash => c.modified.push(path.clone()),
            Some(_) => {}
        }
    }
    for path in old.keys() {
        if !current.contains_key(path) {
            c.removed.push(path.clone());
        }
    }
    c
}

fn list_bucket(label: &str, paths: &[String]) -> String {
    if paths.is_empty() {
        return String::new();
    }
    let shown: Vec<&str> = paths.iter().take(MAX_LISTED).map(String::as_str).collect();
    let more = if paths.len() > MAX_LISTED {
        format!("\n  … and {} more", paths.len() - MAX_LISTED)
    } else {
        String::new()
    };
    format!("\n{label} ({}):\n  {}{more}", paths.len(), shown.join("\n  "))
}

/// The `/init` directive: an orchestrated mapping run, worked as a normal task.
pub fn init_directive() -> String {
    "[/init — map this repository and write its agent documentation]\n\n\
     1. SURVEY the shape yourself first, cheaply: list_dir the root, read the manifest files \
     (Cargo.toml / package.json / etc.), and glob for any existing AGENTS.md or README files. \
     Identify the major components — packages, crates, services, apps.\n\
     2. DELEGATE one subagent per major component, in ONE parallel `run_subagents` call. Each subagent \
     maps its component — entry points, key modules and their responsibilities, internal \
     conventions, how it's built and tested — and returns a tight, factual summary with file paths.\n\
     3. WRITE the documentation from that synthesis:\n\
     \x20  - AGENTS.md at the repo root: what this project is, a per-directory component map, how \
     the pieces fit together, the conventions agents must follow, and the exact build/test/lint \
     commands (run them to verify they work before writing them down).\n\
     \x20  - A nested AGENTS.md inside a subdirectory ONLY where it is a genuinely distinct \
     component with its own conventions or build story (a separate package/crate/service). Don't \
     scatter files into every folder.\n\
     \x20  - If an AGENTS.md already exists anywhere, improve it in place: preserve what's \
     accurate, fix what's stale, keep its voice.\n\
     4. Keep every file tight and factual — paths and commands over prose; document what IS, \
     verified by reading code and running commands, never guessed.\n\n\
     Finish by listing the files you wrote and the component map."
        .to_string()
}

/// The `/knowledge` directive: a doc-sync run over the concrete change set since the last snapshot.
pub fn knowledge_directive(changes: &Changes, unchanged: usize) -> String {
    format!(
        "[/knowledge — re-sync the agent documentation]\n\n\
         The knowledge index (hash snapshot from the last /init or /knowledge run) shows these \
         files changed since the docs were last synced ({unchanged} files unchanged):\n\
         {}{}{}\n\n\
         Bring AGENTS.md (root and nested) back in sync:\n\
         1. Review the changed areas — read the files; `git log`/`git diff` can show what happened \
         recently. Sort the changes: architecturally meaningful (new components, moved \
         responsibilities, changed conventions, new or changed commands) vs routine churn.\n\
         2. DELEGATE parallel reviews when the changes span multiple distinct components.\n\
         3. Update the affected AGENTS.md files precisely: fix stale statements, document new \
         components and conventions, remove docs for deleted things. Routine churn needs NO doc \
         change — don't pad the docs to justify the run.\n\
         4. Finish by reporting exactly what you updated and what you deliberately left alone.",
        list_bucket("MODIFIED", &changes.modified),
        list_bucket("ADDED", &changes.added),
        list_bucket("REMOVED", &changes.removed),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_is_stable() {
        assert_eq!(fnv1a_hex(b""), "cbf29ce484222325");
        assert_eq!(fnv1a_hex(b"hello"), fnv1a_hex(b"hello"));
        assert_ne!(fnv1a_hex(b"hello"), fnv1a_hex(b"hellp"));
    }

    #[test]
    fn diff_detects_adds_mods_and_removals() {
        let old: BTreeMap<String, String> = [
            ("kept.rs".to_string(), "aaaa".to_string()),
            ("changed.rs".to_string(), "bbbb".to_string()),
            ("gone.rs".to_string(), "cccc".to_string()),
        ]
        .into();
        let current: BTreeMap<String, String> = [
            ("kept.rs".to_string(), "aaaa".to_string()),
            ("changed.rs".to_string(), "beef".to_string()),
            ("new.rs".to_string(), "dddd".to_string()),
        ]
        .into();
        let c = diff_manifest(&old, &current);
        assert_eq!(c.added, vec!["new.rs"]);
        assert_eq!(c.modified, vec!["changed.rs"]);
        assert_eq!(c.removed, vec!["gone.rs"]);
        assert!(!c.is_empty());
        assert!(diff_manifest(&old, &old).is_empty());
    }

    #[test]
    fn knowledge_directive_lists_buckets_and_caps() {
        let changes = Changes {
            added: vec!["a.rs".into()],
            modified: (0..100).map(|i| format!("m{i}.rs")).collect(),
            removed: vec![],
        };
        let d = knowledge_directive(&changes, 42);
        assert!(d.contains("ADDED (1):\n  a.rs"));
        assert!(d.contains("MODIFIED (100):"));
        assert!(d.contains("… and 20 more"));
        assert!(!d.contains("REMOVED"), "empty buckets are omitted");
        assert!(d.contains("42 files unchanged"));
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentj-knowledge-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn boilerplate_config_is_created_once_and_parses() {
        let dir = temp_dir("boiler");
        let root = dir.to_str().unwrap();
        assert!(write_boilerplate_config(root, "gpt-5.2").unwrap());
        assert!(!write_boilerplate_config(root, "other").unwrap(), "never overwrites");
        let body = std::fs::read_to_string(dir.join(".aj/aj.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["model"], "gpt-5.2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_and_diff_roundtrip_in_a_real_repo() {
        let dir = temp_dir("repo");
        let root = dir.to_str().unwrap().to_string();
        let git = |args: &[&str], root: &str| {
            let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            let root = root.to_string();
            async move {
                let argv: Vec<&str> = args.iter().map(String::as_str).collect();
                exec::run(&argv, &root, None).await.unwrap()
            }
        };
        git(&["git", "init", "-q"], &root).await;
        std::fs::write(dir.join("code.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.join("doc.md"), "# docs").unwrap();

        let n = snapshot(&root).await.unwrap();
        assert_eq!(n, 2);
        let manifest = load_manifest(&root).expect("manifest written and loadable");
        assert!(manifest.files.contains_key("code.rs"));
        assert!(
            !manifest.files.keys().any(|k| k.starts_with(".aj/")),
            "the index must not index itself"
        );

        // Mutate the tree: modify one file, add one, remove one.
        std::fs::write(dir.join("code.rs"), "fn main() { println!(); }").unwrap();
        std::fs::write(dir.join("new.rs"), "pub fn f() {}").unwrap();
        std::fs::remove_file(dir.join("doc.md")).unwrap();

        let files = tracked_files(&root).await.unwrap();
        let current = hash_files(&root, &files);
        let c = diff_manifest(&manifest.files, &current);
        assert_eq!(c.modified, vec!["code.rs"]);
        assert_eq!(c.added, vec!["new.rs"]);
        assert_eq!(c.removed, vec!["doc.md"]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
