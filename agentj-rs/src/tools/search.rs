//! Search tools: `glob` (find files by pattern, .gitignore-aware) and `grep` (regex over file
//! contents, via ripgrep with a `git grep` fallback).

use super::paths::safe_resolve;
use super::{arg_str, ToolOutcome, Tools};
use crate::exec::run;
use serde_json::Value;

impl Tools {
    pub(super) async fn glob(&self, args: &Value) -> ToolOutcome {
        let pattern = match arg_str(args, "pattern") {
            Some(p) => p,
            None => return ToolOutcome::err("error: glob needs a pattern"),
        };
        if pattern.starts_with('/') || pattern.split('/').any(|s| s == "..") {
            return ToolOutcome::err(
                "error: pattern must stay within the repo (no leading / or '..')",
            );
        }
        let norm = if pattern.contains('/') {
            pattern.to_string()
        } else {
            format!("**/{pattern}")
        };
        let matcher = match glob::Pattern::new(&norm) {
            Ok(m) => m,
            Err(e) => return ToolOutcome::err(format!("error: {e}")),
        };
        // Respect .gitignore via git ls-files; fall back to a filesystem walk.
        let mut hits: Vec<String> = Vec::new();
        if let Ok(o) = run(
            &[
                "git",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            &self.root_str(),
            None,
        )
        .await
        {
            if o.exit_code == 0 {
                for f in o.stdout.lines().filter(|l| !l.is_empty()) {
                    if matcher.matches(f) {
                        hits.push(f.to_string());
                    }
                }
            }
        }
        if hits.is_empty() {
            let root_glob = format!("{}/{}", self.root_str(), norm);
            if let Ok(paths) = glob::glob(&root_glob) {
                for p in paths.flatten() {
                    if let Ok(rel) = p.strip_prefix(&self.root) {
                        let rel = rel.to_string_lossy();
                        if !rel.starts_with("node_modules/") && !rel.starts_with(".git/") {
                            hits.push(rel.into_owned());
                        }
                    }
                }
            }
        }
        hits.sort();
        hits.dedup();
        if hits.is_empty() {
            return ToolOutcome::ok("no matches");
        }
        let shown: String = hits
            .iter()
            .take(100)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        if hits.len() > 100 {
            ToolOutcome::ok(format!("{shown}\n… (+{} more)", hits.len() - 100))
        } else {
            ToolOutcome::ok(shown)
        }
    }

    pub(super) async fn grep(&self, args: &Value) -> ToolOutcome {
        let pattern = match arg_str(args, "pattern") {
            Some(p) => p,
            None => return ToolOutcome::err("error: grep needs a pattern"),
        };
        // An empty path arg means "search the whole repo", not an empty (invalid) path.
        let where_ = match arg_str(args, "path") {
            Some(p) if !p.is_empty() => p,
            _ => ".",
        };
        if let Err(e) = safe_resolve(&self.root, where_) {
            return ToolOutcome::err(format!("error: {e}"));
        }
        let root = self.root_str();
        let (out, err, code) = match run(
            &[
                "rg",
                "--line-number",
                "--no-heading",
                "--color",
                "never",
                pattern,
                where_,
            ],
            &root,
            None,
        )
        .await
        {
            Ok(o) => (o.stdout, o.stderr, o.exit_code),
            Err(_) => match run(
                &["git", "grep", "-n", "-E", pattern, "--", where_],
                &root,
                None,
            )
            .await
            {
                Ok(o) => (o.stdout, o.stderr, o.exit_code),
                Err(e) => return ToolOutcome::err(format!("error: {e}")),
            },
        };
        // rg/git-grep exit 0 = matches, 1 = no matches; anything else is a real error (invalid
        // regex, unreadable path). Surface it so the model doesn't read it as "no matches".
        if code != 0 && code != 1 {
            let detail: String = err.lines().take(3).collect::<Vec<_>>().join("\n");
            return ToolOutcome::err(if detail.trim().is_empty() {
                format!("search failed (exit {code})")
            } else {
                format!("search failed: {detail}")
            });
        }
        if code == 1 || out.trim().is_empty() {
            return ToolOutcome::ok("no matches");
        }
        let lines: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
        let shown = lines
            .iter()
            .take(50)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        if lines.len() > 50 {
            ToolOutcome::ok(format!("{shown}\n… (+{} more matches)", lines.len() - 50))
        } else {
            ToolOutcome::ok(shown)
        }
    }
}
