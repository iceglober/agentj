# agentj docs

A small, dependency-free docs site. Build it with:

```
bun run docs        # or: bun docs/generate.ts
```

That rewrites `index.html` (the site — open it directly, or serve `docs/` on any static host) and `content/reference.generated.md`.

## What is generated vs authored

- **`content/*.md`** — hand-written prose. Add a page by creating the file and listing it in `CONTENT_ORDER` in `generate.ts`.
- **The Commands & keys reference** — generated from `core/lib/chat/commands.ts` (`chatCommands` + `INPUT_AND_KEY_HELP`), the same registry that renders `/help`. It cannot drift from the running CLI. Do not edit `content/reference.generated.md` by hand.

## Drift guard

`generate.test.ts` re-renders in memory and pins it against the committed files. If you add a command or edit prose without running `bun run docs`, `bun test core` (and CI) go red. Regenerate and commit.

## Not yet generated

The command-line surface (`agentj run`, its flags, `config`) is described in the quickstart prose for now. `cmd-ts` does not expose its argument definitions for introspection, so an auto-generated CLI table is a follow-up — it would mean data-driving those descriptions so one source feeds both `--help` and these docs.
