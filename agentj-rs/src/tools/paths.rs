//! Repo-root confinement: every path a tool touches resolves through [`safe_resolve`].

use std::fs;
use std::path::{Path, PathBuf};

/// Resolve `rel` against `root` and confine it there (rejects `..` / symlink escapes), even when the
/// target doesn't exist yet (write_file).
pub(super) fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let real_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let abs = real_root.join(rel);
    let mut existing = abs.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(name) => tail.push(name.to_os_string()),
            None => break,
        }
        match existing.parent() {
            Some(p) => existing = p.to_path_buf(),
            None => break,
        }
    }
    let mut final_path = fs::canonicalize(&existing).map_err(|e| e.to_string())?;
    for seg in tail.iter().rev() {
        final_path.push(seg);
    }
    if !final_path.starts_with(&real_root) {
        return Err(format!("path escapes the repo root: {rel}"));
    }
    Ok(final_path)
}
