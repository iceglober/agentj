# glorious docs

A small, dependency-free docs site. Build it with:

```
bun run docs        # or: bun docs/generate.ts
```

That rewrites `index.html` (the site — open it directly, or serve `docs/` on any static host) and the `content/*.generated.md` files.

## What is generated vs authored

- **`content/*.md`** — hand-written prose. Add a page by creating the file and listing it in `CONTENT_ORDER` in `generate.ts`.
- **The Command line reference** — generated from the CLI's own `command()` definitions via `describeCli()` in `core/lib/cli/index.ts`, which reads cmd-ts's `helpTopics()`. The same structure backs `glorious --help`, so the two cannot disagree.
- **The Commands & keys reference** — generated from `core/lib/chat/commands.ts` (`chatCommands` + `INPUT_AND_KEY_HELP`), the same registry that renders `/help`. It cannot drift from the running CLI.
- **The Configuration reference** — keys and defaults come from the live schema (`listConfigPaths()` + `configSchema.parse({})`); only the editorial descriptions are authored, in `content/config-reference.ts`. Every documented path is validated against the schema at build time, so a rename or removal fails the build.
- The `*.generated.md` files are outputs. Do not edit them by hand.

Advanced material is wrapped in `:::details <summary>` … `:::` so it renders as a collapsed disclosure and stays out of the nav; lead with the common case.

## Drift guard

`generate.test.ts` re-renders in memory and pins it against the committed files. Add a command or flag, change a config default, or edit prose without running `bun run docs` and `bun test core docs` (and CI) go red. Regenerate and commit.
