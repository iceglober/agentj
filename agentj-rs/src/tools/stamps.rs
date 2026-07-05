//! The read-stamp staleness guard: edits must land on what the model actually saw.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Content hash of each file at its last read/write through the tools. Edit tools compare against
/// it so an edit lands on what the model actually saw — a file changed on disk since the last read
/// fails with "re-read" instead of silently editing drifted content.
pub(super) struct ReadStamps(Mutex<HashMap<PathBuf, u64>>);

impl ReadStamps {
    pub(super) fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    /// Record the content the model just saw (or wrote) at `abs`.
    pub(super) fn record(&self, abs: &Path, text: &str) {
        self.0
            .lock()
            .unwrap()
            .insert(abs.to_path_buf(), content_stamp(text));
    }

    /// `Some(error)` when the file on disk no longer matches what the model last read through these
    /// tools (an external change). No stamp yet → not stale (the model may edit blind; the edit
    /// tools' own match checks still guard correctness).
    pub(super) fn stale_error(&self, abs: &Path, current: &str, path: &str) -> Option<String> {
        let stamps = self.0.lock().unwrap();
        match stamps.get(abs) {
            Some(&s) if s != content_stamp(current) => Some(format!(
                "error: {path} changed on disk since you last read it — re-read it before editing"
            )),
            _ => None,
        }
    }
}

fn content_stamp(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}
