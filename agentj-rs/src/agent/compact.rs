//! Context compaction: reclaim prompt space by eliding the bodies of older, already-seen tool
//! results once a turn's context passes the threshold. A safety valve, not a summarizer — the
//! durable (TUI) history keeps the full text.

use crate::provider::ChatMessage;

/// Tool results newer than this many stay verbatim during compaction.
pub(super) const COMPACT_KEEP_RECENT: usize = 8;

/// Elide the BODIES of older tool results to reclaim context. Two protections keep it safe:
///  - `seen_before`: only messages at an index below this are touched — a tool result produced
///    since the last model call (index >= seen_before) has never been shown to the model, so
///    eliding it would make the model reason over an "[elided]" placeholder for output it never saw.
///  - `keep_recent`: the most recent tool results stay verbatim regardless, so recent context stays
///    rich. Messages themselves are never removed — the OpenAI wire format requires a tool reply per
///    tool_call id. Returns how many bodies were elided.
pub(super) fn compact_history(
    messages: &mut [ChatMessage],
    keep_recent: usize,
    seen_before: usize,
) -> usize {
    let tool_idxs: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(i, m)| m.role == "tool" && *i < seen_before)
        .map(|(i, _)| i)
        .collect();
    if tool_idxs.len() <= keep_recent {
        return 0;
    }
    let mut elided = 0;
    for &i in &tool_idxs[..tool_idxs.len() - keep_recent] {
        if let Some(c) = &messages[i].content {
            if c.len() > 200 && !c.starts_with("[elided") {
                messages[i].content = Some(format!(
                    "[elided older tool result ({} chars) — re-run the tool if you need it again]",
                    c.len()
                ));
                elided += 1;
            }
        }
    }
    elided
}

/// Cheap upper-bound estimate of the prompt's token count (~4 chars/token over message content and
/// tool-call arguments), used to trigger compaction BEFORE the first model call of a turn — where
/// the accurate post-response `prompt_tokens` isn't available yet but the history may already be huge.
pub(super) fn estimate_prompt_tokens(messages: &[ChatMessage]) -> u64 {
    let chars: usize = messages
        .iter()
        .map(|m| {
            m.content.as_ref().map_or(0, |c| c.len())
                + m.tool_calls
                    .iter()
                    .map(|tc| tc.function.arguments.len() + tc.function.name.len())
                    .sum::<usize>()
        })
        .sum();
    (chars / 4) as u64
}
