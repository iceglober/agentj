---
"@glrs-dev/aj": patch
---

Permission prompts show the actual command inside the modal (wrapped, indented) instead of pointing at a transcript line that may have scrolled away; only requests longer than six wrapped lines also print a full transcript copy, with the modal noting how many lines it omitted.
