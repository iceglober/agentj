---
"@glrs-dev/aj": minor
---

Redesign how the transcript renders through one typed seam. Every transcript entry — user turn, assistant reply, tool call, completion report, notice, job — becomes a `TranscriptItem` lowered to the semantic UiBlock model by a single `renderTranscriptItem`, so both interfaces render from one source of truth and a row's look changes in one place. Visible results: tool rows stop painting whole lines green (only the ✓/✗/⊘ marker is toned, with the tool name plain and detail muted); completion reports get real section headers and a tone-coded status line; and reflection reviews render as one terse finding instead of a wall of raw JSON.
