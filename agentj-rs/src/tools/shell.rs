//! Shell tools: `bash` (foreground, bounded) and `job_start` (background via the job manager).
//! Both run through `exec::run`, which owns process-group kill semantics.

use super::{arg_str, ToolOutcome, Tools};
use crate::exec::run;
use crate::util::head_tail;
use serde_json::Value;
use std::time::Duration;

const BASH_TIMEOUT: Duration = Duration::from_secs(120);

impl Tools {
    pub(super) async fn bash(&self, args: &Value) -> ToolOutcome {
        let command = match arg_str(args, "command") {
            Some(c) => c,
            None => return ToolOutcome::err("error: bash needs a command"),
        };
        // Optional per-call timeout, clamped to 1..=600s; falls back to the default.
        let timeout = args
            .get("timeout_s")
            .and_then(|v| v.as_u64())
            .map(|s| Duration::from_secs(s.clamp(1, 600)))
            .unwrap_or(BASH_TIMEOUT);
        match run(&["bash", "-lc", command], &self.root_str(), Some(timeout)).await {
            Ok(o) => {
                let raw: String = [o.stdout.trim_end(), o.stderr.trim_end()]
                    .iter()
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let note = if o.timed_out {
                    format!("\n[timed out after {}s]", timeout.as_secs())
                } else {
                    String::new()
                };
                // The command ran — a non-zero exit is a normal result, not a tool failure.
                ToolOutcome::ok(
                    format!(
                        "{}\n[exit {}]{}",
                        head_tail(&raw, 4000, 2000),
                        o.exit_code,
                        note
                    )
                    .trim()
                    .to_string(),
                )
            }
            Err(e) => ToolOutcome::err(format!("error: {e}")),
        }
    }

    pub(super) async fn job_start(&self, args: &Value) -> ToolOutcome {
        let command = match arg_str(args, "command") {
            Some(c) => c,
            None => return ToolOutcome::err("error: job_start needs a command"),
        };
        let timeout = args
            .get("timeout_s")
            .and_then(|v| v.as_u64())
            .map(Duration::from_secs);
        match self.jobs.start(command, timeout).await {
            Ok(id) => ToolOutcome::ok(format!(
                "started job {id} in the background — keep working; you'll be nudged when it finishes{}.",
                timeout.map(|t| format!(" or after {}s", t.as_secs())).unwrap_or_default()
            )),
            Err(e) => ToolOutcome::err(format!("error: {e}")),
        }
    }
}
