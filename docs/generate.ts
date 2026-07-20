#!/usr/bin/env bun
/**
 * Builds the agentj docs site under `docs/`. The user-facing reference is
 * generated from the same code the CLI runs — the `chatCommands` registry and
 * the key-binding constant that back `/help` — so the command list can never
 * drift from the product. Hand-written prose lives in `docs/content/*.md`.
 *
 * `bun docs/generate.ts` (or `bun run docs`) rewrites the committed output;
 * `generate.test.ts` pins the committed files against a fresh render, so a new
 * command with no regenerate turns CI red. Render functions are pure and
 * exported for that test; only `main()` touches the filesystem.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatCommands, INPUT_AND_KEY_HELP } from "../core/lib/chat/commands";
import { type CliCommandDoc, describeCli } from "../core/lib/cli";
import { configSchema } from "../core/lib/config";
import { CONFIG_DOCS, type ConfigDoc } from "../core/lib/config/reference";
import { listConfigPaths } from "../core/lib/config-cli";

const DOCS_DIR = new URL(".", import.meta.url).pathname;
const CONTENT_DIR = join(DOCS_DIR, "content");

/** The generated reference, as Markdown, sourced from the live registry. */
export function renderReferenceMarkdown(): string {
  const commands = Object.entries(chatCommands).map(
    ([name, command]) => `- \`/${name}\` — ${command.summary}`,
  );
  return [
    "## Commands & keys",
    "",
    "In-session slash commands and key bindings — the same list `/help` prints, generated from the registry so it always matches your version.",
    "",
    ":::details Show every slash command and key binding",
    "",
    "### Slash commands",
    "",
    ...commands,
    "",
    "### Input & keys",
    "",
    ...INPUT_AND_KEY_HELP.map((line) => `- ${line}`),
    "",
    ":::",
    "",
  ].join("\n");
}

/** Render a schema default as inline-code Markdown, or "unset" when absent. */
const formatDefault = (value: unknown): string => {
  if (value === undefined) return "unset";
  if (Array.isArray(value)) return value.length === 0 ? "`[]`" : `\`${JSON.stringify(value)}\``;
  return `\`${JSON.stringify(value)}\``;
};

/**
 * The configuration reference: keys and defaults from the live schema, editorial
 * text from `CONFIG_DOCS`. Throws if a documented key is not a real config path,
 * so a rename can't silently ship a stale doc.
 */
export function renderConfigMarkdown(docs: readonly ConfigDoc[] = CONFIG_DOCS): string {
  const valid = new Set(listConfigPaths());
  const unknown = docs.filter((doc) => !valid.has(doc.path)).map((doc) => doc.path);
  if (unknown.length > 0) {
    throw new Error(`CONFIG_DOCS references unknown config paths: ${unknown.join(", ")}`);
  }
  const defaults = configSchema.parse({}) as Record<string, unknown>;
  const at = (path: string): unknown =>
    path
      .split(".")
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], defaults);
  return [
    "## Configuration reference",
    "",
    "Set with `agentj config set <key> <value>`; read with `agentj config get <key>`. Global writes use `~/.config/aj/config.json`; project settings layer from `.aj/config.json` and `.aj/config.local.json`. Defaults come straight from the schema.",
    "",
    ":::details Show all configuration keys",
    "",
    ...docs.map(
      (doc) => `- \`${doc.path}\` (default: ${formatDefault(at(doc.path))}) — ${doc.description}`,
    ),
    "",
    ":::",
    "",
  ].join("\n");
}

/**
 * The command-line reference, sourced from the CLI's own `command()` definitions
 * via `describeCli()` — so it can never disagree with `agentj --help`.
 */
export function renderCliMarkdown(commands: readonly CliCommandDoc[] = describeCli()): string {
  const lines = [
    "## Command line",
    "",
    "Every subcommand, argument, and flag — generated from the same definitions `agentj --help` prints.",
    "",
    ":::details Show all commands and flags",
    "",
  ];
  for (const command of commands) {
    const usage = [command.name, ...command.args.map((arg) => arg.usage)].join(" ");
    lines.push(`### \`${usage}\``, "", command.description, "");
    for (const item of [...command.args, ...command.flags]) {
      lines.push(`- \`${item.usage}\` — ${item.description}`);
    }
    lines.push("");
  }
  lines.push(":::", "");
  return lines.join("\n");
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline spans: `code`, **bold**, and [text](href). Escaped before wrapping so
 *  the source Markdown is treated as text, never HTML. */
const renderInline = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);

export interface DocHeading {
  level: number;
  text: string;
  id: string;
}

/** URL-fragment slug; collisions are disambiguated by the caller. */
const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "section";

/**
 * A deliberately small Markdown subset — headings (#..###), paragraphs, fenced
 * code, unordered lists, and the inline spans above. Enough for reference docs
 * without a parser dependency; keep authored prose within it. Headings get a
 * unique `id` for anchoring, and h1/h2 are returned so the caller can build the
 * table of contents from the same pass — the nav can't drift from the content.
 */
export function markdownToHtml(markdown: string): { html: string; headings: DocHeading[] } {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const headings: DocHeading[] = [];
  const slugCounts = new Map<string, number>();
  let inCode = false;
  let code: string[] = [];
  let list: string[] = [];
  // Depth of open `:::details` blocks. Headings inside one are collapsed by
  // default, so they stay out of the nav.
  let detailsDepth = 0;
  const flushList = () => {
    if (list.length > 0) {
      out.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
      list = [];
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const openDetails = /^:::details\s+(.*)$/.exec(line);
    if (openDetails) {
      flushList();
      detailsDepth += 1;
      out.push(`<details><summary>${renderInline(openDetails[1])}</summary>`);
      continue;
    }
    if (line.trim() === ":::" && detailsDepth > 0) {
      flushList();
      detailsDepth -= 1;
      out.push("</details>");
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const text = heading[2];
      const base = slugify(text);
      const seen = (slugCounts.get(base) ?? 0) + 1;
      slugCounts.set(base, seen);
      const id = seen === 1 ? base : `${base}-${seen}`;
      if (level <= 2 && detailsDepth === 0) headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      continue;
    }
    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      continue;
    }
    flushList();
    if (line.trim().length > 0) out.push(`<p>${renderInline(line)}</p>`);
  }
  flushList();
  for (; detailsDepth > 0; detailsDepth -= 1) out.push("</details>");
  return { html: out.join("\n"), headings };
}

/** The sticky table of contents, built from the page's h1/h2 headings. */
function renderNav(headings: readonly DocHeading[]): string {
  const links = headings
    .map((h) => `<a class="nav-h${h.level}" href="#${h.id}">${renderInline(h.text)}</a>`)
    .join("");
  return `<nav class="toc" aria-label="Sections">${links}</nav>`;
}

const PAGE_STYLE = `
:root { color-scheme: light dark; --fg:#1a1a1a; --muted:#666; --bg:#fff; --code:#f4f4f5; --border:#e4e4e7; --accent:#3b5bdb; }
@media (prefers-color-scheme: dark) { :root { --fg:#e7e7e9; --muted:#9a9aa2; --bg:#161618; --code:#232327; --border:#2e2e33; --accent:#8facff; } }
/* Element rules first, then classes — ascending specificity keeps the cascade honest. */
* { box-sizing: border-box; }
body { margin:0; color:var(--fg); background:var(--bg); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
h1 { font-size:2rem; margin:0 0 .25rem; letter-spacing:-.02em; }
h1:not(:first-child) { margin-top:3rem; padding-top:1.5rem; border-top:1px solid var(--border); }
h2 { font-size:1.35rem; margin:2.5rem 0 .75rem; padding-top:1rem; border-top:1px solid var(--border); letter-spacing:-.01em; }
h3 { font-size:1.05rem; margin:1.5rem 0 .5rem; }
p { margin:.6rem 0; }
ul { margin:.6rem 0; padding-left:1.25rem; }
li { margin:.25rem 0; }
code { background:var(--code); padding:.12em .38em; border-radius:.35rem; font:.88em ui-monospace,SFMono-Regular,Menlo,monospace; }
pre { background:var(--code); border:1px solid var(--border); border-radius:.6rem; padding:1rem; overflow-x:auto; }
pre code { background:none; padding:0; }
details { margin:.75rem 0; border:1px solid var(--border); border-radius:.6rem; padding:0 1rem; background:color-mix(in srgb, var(--code) 45%, transparent); }
details[open] { padding-bottom:.5rem; }
summary { cursor:pointer; padding:.7rem 0; font-weight:600; color:var(--fg); list-style:none; }
summary::-webkit-details-marker { display:none; }
summary::before { content:"\\203A"; display:inline-block; width:1.1em; color:var(--muted); transition:transform .15s; }
details[open] > summary::before { transform:rotate(90deg); }
summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:3px; }
footer { color:var(--muted); font-size:.85rem; margin-top:4rem; border-top:1px solid var(--border); padding-top:1rem; }
.layout { display:grid; grid-template-columns:13rem minmax(0,44rem); gap:3rem; max-width:60rem; margin:0 auto; padding:3rem 1.5rem 6rem; align-items:start; }
main { min-width:0; }
nav.toc { position:sticky; top:2rem; display:flex; flex-direction:column; gap:.1rem; font-size:.875rem; max-height:calc(100vh - 4rem); overflow-y:auto; }
nav.toc a { color:var(--muted); text-decoration:none; padding:.2rem 0 .2rem .75rem; border-left:2px solid transparent; line-height:1.35; }
nav.toc a:hover { color:var(--fg); text-decoration:none; }
nav.toc a[aria-current] { color:var(--accent); border-left-color:var(--accent); }
nav.toc a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:2px; }
nav.toc .nav-h1 { color:var(--fg); font-weight:600; margin-top:.9rem; border-left-color:transparent; }
nav.toc .nav-h1:first-child { margin-top:0; }
nav.toc .nav-h2 { padding-left:1.5rem; }
@media (max-width:820px) {
  .layout { grid-template-columns:minmax(0,1fr); gap:0; padding:1.5rem 1.25rem 5rem; }
  nav.toc { position:static; top:auto; flex-direction:row; flex-wrap:wrap; gap:.25rem 1.25rem; max-height:none; margin-bottom:1.75rem; padding-bottom:1rem; border-bottom:1px solid var(--border); }
  nav.toc a { border-left:none; padding-left:0; }
  nav.toc .nav-h1 { margin-top:0; }
  nav.toc .nav-h2 { display:none; }
}
@media (prefers-reduced-motion:no-preference) { html { scroll-behavior:smooth; } }
`.trim();

/**
 * Highlights the table-of-contents link for whichever section heading is near
 * the top of the viewport. No dependency, no motion — pure state feedback for a
 * long page — so it needs no reduced-motion guard.
 */
const SCROLLSPY = `
(() => {
  const links = new Map([...document.querySelectorAll('.toc a')].map(a => [a.hash.slice(1), a]));
  const heads = [...document.querySelectorAll('main h1[id], main h2[id]')];
  if (!heads.length) return;
  let active = null;
  const setActive = (h) => {
    if (h === active) return;
    active = h;
    for (const a of links.values()) a.removeAttribute('aria-current');
    links.get(h.id)?.setAttribute('aria-current', 'true');
  };
  const update = () => {
    // The current section is the last heading whose top has passed the marker
    // line; deterministic at the top, between headings, and at page end.
    const marker = 120;
    let current = heads[0];
    for (const h of heads) {
      if (h.getBoundingClientRect().top <= marker) current = h;
      else break;
    }
    if (innerHeight + scrollY >= document.body.scrollHeight - 2) current = heads[heads.length - 1];
    setActive(current);
  };
  update();
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
})();
`.trim();

/** Assemble the single-page site from the authored prose and generated
 *  reference. Rendering the concatenated Markdown in one pass keeps heading ids
 *  unique across sections and lets the nav come from the same headings. */
export function renderSite(sections: string[]): string {
  const { html, headings } = markdownToHtml(sections.join("\n"));
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>agentj — docs</title>",
    `<style>\n${PAGE_STYLE}\n</style>`,
    "</head>",
    "<body>",
    '<div class="layout">',
    renderNav(headings),
    "<main>",
    html,
    "<footer>Reference generated from the agentj source. Rebuild with <code>bun run docs</code>.</footer>",
    "</main>",
    "</div>",
    `<script>\n${SCROLLSPY}\n</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Prose pages, in site order. Reference is appended after them, generated. */
const CONTENT_ORDER = ["index.md"] as const;

/** The full set of files the generator owns, as {relativePath: contents}. */
export function buildOutputs(): Record<string, string> {
  const cli = renderCliMarkdown();
  const reference = renderReferenceMarkdown();
  const config = renderConfigMarkdown();
  const prose = CONTENT_ORDER.map((name) => readFileSync(join(CONTENT_DIR, name), "utf8"));
  return {
    "content/cli.generated.md": cli,
    "content/reference.generated.md": reference,
    "content/config.generated.md": config,
    "index.html": renderSite([...prose, cli, reference, config]),
  };
}

function main(): void {
  // Guard against an authored page being added without wiring it in.
  const authored = readdirSync(CONTENT_DIR).filter(
    (name) => name.endsWith(".md") && !name.endsWith(".generated.md"),
  );
  const missing = authored.filter((name) => !CONTENT_ORDER.includes(name as never));
  if (missing.length > 0) {
    throw new Error(`content/${missing.join(", ")} not listed in CONTENT_ORDER`);
  }
  for (const [path, contents] of Object.entries(buildOutputs())) {
    writeFileSync(join(DOCS_DIR, path), contents);
  }
  process.stdout.write("docs: wrote index.html and content/reference.generated.md\n");
}

if (import.meta.main) main();
