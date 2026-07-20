---
"@glrs-dev/aj": minor
---

The chat editor now fuzzy-completes slash commands and project file references wherever the token starts at the beginning of input or after whitespace. For example, type `review @agt` and press Tab to insert a matching project file, or type `review /bld` to complete `/build` without turning surrounding prose into a command. Slash commands use cyan, file references use green, and a leading `&` switches the editor to a clear yellow `BACKGROUND JOB` state. Structured agent completion reports now keep their changes, validation evidence, and open questions in the transcript instead of showing only a summary.
