//! File tools: read, write, string- and line-anchored edits, and directory listing. Every path
//! passes through `safe_resolve`; edits echo the changed region so a verification re-read is
//! unnecessary.

use super::paths::{safe_resolve, safe_resolve_read};
use super::{arg_str, ToolOutcome, Tools};
use crate::util::clip;
use serde_json::Value;
use std::fs;

/// Numbered lines around the first line containing `needle` — the post-edit echo that makes a
/// verification re-read unnecessary. `None` when the needle isn't found (e.g. a pure deletion).
fn context_snippet(text: &str, needle: &str, around: usize) -> Option<String> {
    let needle = needle.trim();
    if needle.is_empty() {
        return None;
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let hit = lines.iter().position(|l| l.contains(needle))?;
    let lo = hit.saturating_sub(around);
    let hi = (hit + around + 1).min(lines.len());
    Some(
        (lo..hi)
            .map(|i| format!("{}\t{}", i + 1, lines[i]))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

impl Tools {
    pub(super) fn read_file(&self, args: &Value) -> ToolOutcome {
        let path = match arg_str(args, "path") {
            Some(p) => p,
            None => return ToolOutcome::err("error: read_file needs a path"),
        };
        // Reads (only) may also reach the user-level skills dir the prompt index advertises.
        let abs = match safe_resolve_read(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let bytes = match fs::read(&abs) {
            Ok(b) => b,
            Err(_) => return ToolOutcome::err(format!("file not found: {path}")),
        };
        if bytes.is_empty() {
            return ToolOutcome::ok("(empty file)");
        }
        if bytes.iter().take(8000).any(|&b| b == 0) {
            return ToolOutcome::ok(format!("[binary file, {} bytes, not shown]", bytes.len()));
        }
        let text = String::from_utf8_lossy(&bytes);
        self.stamps.record(&abs, &text); // edits verify against what was actually read
        let lines: Vec<&str> = text.split('\n').collect();
        let total = lines.len();
        let offset = args
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .max(1) as usize;
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(400)
            .clamp(1, 1200) as usize;
        if offset > total {
            return ToolOutcome::err(format!(
                "{path}: {total} lines; offset {offset} is past the end"
            ));
        }
        let end = (offset - 1 + limit).min(total);
        let numbered: String = lines[offset - 1..end]
            .iter()
            .enumerate()
            .map(|(i, l)| format!("{}\t{}", offset + i, l))
            .collect::<Vec<_>>()
            .join("\n");
        let note = if offset > 1 || end < total {
            format!("\n[lines {offset}–{end} of {total}; pass offset/limit for more]")
        } else {
            String::new()
        };
        ToolOutcome::ok(format!("{}{}", clip(&numbered, 40_000), note))
    }

    pub(super) fn write_file(&self, args: &Value) -> ToolOutcome {
        let (path, content) = match (arg_str(args, "path"), arg_str(args, "content")) {
            (Some(p), Some(c)) => (p, c),
            _ => return ToolOutcome::err("error: write_file needs path and content"),
        };
        let abs = match safe_resolve(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        if let Some(parent) = abs.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match fs::write(&abs, content) {
            Ok(_) => {
                self.stamps.record(&abs, content);
                // `.aj/` is agent scratch (task frontiers, the knowledge index) — keep it out of
                // git without touching the user's .gitignore: a self-ignoring directory. Keyed off
                // the RELATIVE path (`abs` is canonicalized; `self.root` may not be).
                let rel = path.trim_start_matches("./");
                if rel.starts_with(".aj/") {
                    let aj = self.root.join(".aj");
                    if !aj.join(".gitignore").exists() {
                        let _ = fs::write(aj.join(".gitignore"), "*\n");
                    }
                }
                ToolOutcome::ok(format!("wrote {} bytes to {path}", content.len()))
            }
            Err(e) => ToolOutcome::err(format!("error: {e}")),
        }
    }

    /// One or MANY string replacements in a single call. Batching related fixes into one `edits`
    /// array is the cheap path: every extra tool round-trip re-sends the whole conversation. Edits
    /// apply in order against the evolving text and are atomic — if any fails, nothing is written and
    /// the error names which one. The result echoes the changed regions so a verification re-read is
    /// unnecessary.
    pub(super) fn edit_file(&self, args: &Value) -> ToolOutcome {
        let Some(path) = arg_str(args, "path") else {
            return ToolOutcome::err("error: edit_file needs a path");
        };
        let abs = match safe_resolve(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let text = match fs::read_to_string(&abs) {
            Ok(t) => t,
            Err(_) => return ToolOutcome::err(format!("file not found: {path}")),
        };
        if let Some(stale) = self.stamps.stale_error(&abs, &text, path) {
            return ToolOutcome::err(stale);
        }

        // Ops: an `edits` array, or the single old_string/new_string form.
        let mut ops: Vec<(String, String, bool)> = Vec::new();
        if let Some(arr) = args.get("edits").and_then(|v| v.as_array()) {
            for (i, e) in arr.iter().enumerate() {
                match (
                    e.get("old_string").and_then(|v| v.as_str()),
                    e.get("new_string").and_then(|v| v.as_str()),
                ) {
                    (Some(o), Some(n)) => ops.push((
                        o.to_string(),
                        n.to_string(),
                        e.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false),
                    )),
                    _ => {
                        return ToolOutcome::err(format!(
                            "error: edits[{i}] needs old_string and new_string"
                        ))
                    }
                }
            }
        } else if let (Some(o), Some(n)) = (arg_str(args, "old_string"), arg_str(args, "new_string")) {
            ops.push((
                o.to_string(),
                n.to_string(),
                args.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false),
            ));
        }
        if ops.is_empty() {
            return ToolOutcome::err(
                "error: edit_file needs old_string+new_string, or an `edits` array of them",
            );
        }

        let n_ops = ops.len();
        let mut updated = text;
        let mut replaced_total = 0usize;
        for (i, (old, new, replace_all)) in ops.iter().enumerate() {
            let at = |msg: String| {
                if n_ops > 1 {
                    format!("edit {}/{n_ops}: {msg} — NOTHING was written (edits are atomic); fix and resend the batch", i + 1)
                } else {
                    msg
                }
            };
            let count = updated.matches(old.as_str()).count();
            if count == 0 {
                // Nearest-match echo: anchor on old_string's first non-empty line; if the file has
                // it, show that region so a whitespace/context drift is repairable in ONE resend
                // instead of a read → retry loop (observed live costing ~6 round-trips).
                let hint = old
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .and_then(|a| context_snippet(&updated, a, 6))
                    .map(|s| format!("\nNearest match to its first line:\n{s}"))
                    .unwrap_or_default();
                return ToolOutcome::err(at(format!(
                    "old_string not found in {path} — it differs from the file (whitespace or drifted context){hint}"
                )));
            }
            if count > 1 && !replace_all {
                return ToolOutcome::err(at(format!(
                    "old_string is not unique in {path} ({count} matches) — add more context, or pass replace_all"
                )));
            }
            updated = if *replace_all {
                replaced_total += count;
                updated.replace(old.as_str(), new)
            } else {
                replaced_total += 1;
                updated.replacen(old.as_str(), new, 1)
            };
        }
        if let Err(e) = fs::write(&abs, &updated) {
            return ToolOutcome::err(format!("error: {e}"));
        }
        self.stamps.record(&abs, &updated);

        // Echo the changed regions (result-side verification — no re-read round-trip needed).
        let mut echo = String::new();
        for (old, new, _) in ops.iter().take(5) {
            let anchor = new.lines().next().filter(|l| !l.trim().is_empty());
            let target = anchor.or_else(|| old.lines().next());
            if let Some(t) = target {
                if let Some(snip) = context_snippet(&updated, t, 2) {
                    echo.push('\n');
                    echo.push_str(&snip);
                }
            }
        }
        ToolOutcome::ok(format!(
            "edited {path} ({replaced_total} replacement{}){echo}",
            if replaced_total == 1 { "" } else { "s" }
        ))
    }

    /// Replace an inclusive 1-based line range, anchored by the numbers `read_file` prints plus an
    /// `expect` prefix of the first line — so a drifted file fails with the current region instead of
    /// silently editing the wrong lines. Line-precise and whitespace-light where exact string
    /// reproduction is awkward.
    pub(super) fn edit_lines(&self, args: &Value) -> ToolOutcome {
        let (Some(path), Some(start), Some(end), Some(expect), Some(content)) = (
            arg_str(args, "path"),
            args.get("start_line").and_then(|v| v.as_u64()),
            args.get("end_line").and_then(|v| v.as_u64()),
            arg_str(args, "expect"),
            arg_str(args, "content"),
        ) else {
            return ToolOutcome::err(
                "error: edit_lines needs path, start_line, end_line, expect (prefix of the first line being replaced), content (empty deletes the range)",
            );
        };
        let abs = match safe_resolve(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let text = match fs::read_to_string(&abs) {
            Ok(t) => t,
            Err(_) => return ToolOutcome::err(format!("file not found: {path}")),
        };
        if let Some(stale) = self.stamps.stale_error(&abs, &text, path) {
            return ToolOutcome::err(stale);
        }
        let lines: Vec<&str> = text.split('\n').collect();
        let total = lines.len();
        let (start, end) = (start as usize, end as usize);
        if start < 1 || end < start || end > total {
            return ToolOutcome::err(format!(
                "error: invalid range {start}–{end} ({path} has {total} lines)"
            ));
        }
        // Anchor check: the first line being replaced must still start with `expect` (whitespace
        // relaxed). A mismatch returns the current region so re-anchoring needs no full re-read.
        let anchor = lines[start - 1].trim_start();
        if expect.trim().is_empty() || !anchor.starts_with(expect.trim_start().trim_end()) {
            let lo = start.saturating_sub(3).max(1);
            let hi = (end + 2).min(total);
            let region: String = (lo..=hi)
                .map(|n| format!("{n}\t{}", lines[n - 1]))
                .collect::<Vec<_>>()
                .join("\n");
            return ToolOutcome::err(format!(
                "line {start} of {path} doesn't start with your `expect` — the region currently reads:\n{region}\nre-anchor (adjust start_line/expect) and retry"
            ));
        }
        let mut out: Vec<&str> = Vec::with_capacity(total);
        out.extend(&lines[..start - 1]);
        if !content.is_empty() {
            out.extend(content.split('\n'));
        }
        out.extend(&lines[end..]);
        let updated = out.join("\n");
        if let Err(e) = fs::write(&abs, &updated) {
            return ToolOutcome::err(format!("error: {e}"));
        }
        self.stamps.record(&abs, &updated);
        let ulines: Vec<&str> = updated.split('\n').collect();
        let lo = start.saturating_sub(2).max(1);
        let hi = (start + content.split('\n').count() + 1).min(ulines.len());
        let echo: String = (lo..=hi)
            .map(|n| format!("{n}\t{}", ulines[n - 1]))
            .collect::<Vec<_>>()
            .join("\n");
        ToolOutcome::ok(format!(
            "edited {path} lines {start}–{end}; now:\n{echo}"
        ))
    }

    pub(super) fn list_dir(&self, args: &Value) -> ToolOutcome {
        let path = arg_str(args, "path").unwrap_or(".");
        let abs = match safe_resolve(&self.root, path) {
            Ok(a) => a,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let entries = match fs::read_dir(&abs) {
            Ok(e) => e,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                if e.path().is_dir() {
                    format!("{n}/")
                } else {
                    n
                }
            })
            .collect();
        names.sort();
        if names.is_empty() {
            ToolOutcome::ok("(empty)")
        } else {
            ToolOutcome::ok(clip(&names.join("\n"), 8000))
        }
    }
}
