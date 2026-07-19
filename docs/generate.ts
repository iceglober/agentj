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
import { configSchema } from "../core/lib/config";
import { listConfigPaths } from "../core/lib/config-cli";
import { CONFIG_DOCS, type ConfigDoc } from "./content/config-reference";

const DOCS_DIR = new URL(".", import.meta.url).pathname;
const CONTENT_DIR = join(DOCS_DIR, "content");

/** The generated reference, as Markdown, sourced from the live registry. */
export function renderReferenceMarkdown(): string {
  const commands = Object.entries(chatCommands).map(
    ([name, command]) => `- \`/${name}\` — ${command.summary}`,
  );
  return [
    "# Commands & keys",
    "",
    "Generated from the command registry that powers `/help`. Do not edit by hand — run `bun run docs`.",
    "",
    "## Slash commands",
    "",
    ...commands,
    "",
    "## Input & keys",
    "",
    ...INPUT_AND_KEY_HELP.map((line) => `- ${line}`),
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
    "# Configuration",
    "",
    "Set with `agentj config set <key> <value>`; read with `agentj config get <key>`. Stored in `~/.config/agentj/config.json`. Defaults below come straight from the schema.",
    "",
    ...docs.map(
      (doc) => `- \`${doc.path}\` (default: ${formatDefault(at(doc.path))}) — ${doc.description}`,
    ),
    "",
  ].join("\n");
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

/**
 * A deliberately small Markdown subset — headings (#..###), paragraphs, fenced
 * code, unordered lists, and the inline spans above. Enough for reference docs
 * without a parser dependency; keep authored prose within it.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let list: string[] = [];
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
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
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
  return out.join("\n");
}

const PAGE_STYLE = `
:root { color-scheme: light dark; --fg:#1a1a1a; --muted:#666; --bg:#fff; --code:#f4f4f5; --border:#e4e4e7; --accent:#3b5bdb; }
@media (prefers-color-scheme: dark) { :root { --fg:#e7e7e9; --muted:#9a9aa2; --bg:#161618; --code:#232327; --border:#2e2e33; --accent:#8facff; } }
* { box-sizing: border-box; }
body { margin:0; color:var(--fg); background:var(--bg); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
main { max-width:44rem; margin:0 auto; padding:3rem 1.25rem 6rem; }
h1 { font-size:2rem; margin:0 0 .25rem; letter-spacing:-.02em; }
h2 { font-size:1.35rem; margin:2.5rem 0 .75rem; padding-top:1rem; border-top:1px solid var(--border); letter-spacing:-.01em; }
h3 { font-size:1.05rem; margin:1.5rem 0 .5rem; }
p { margin:.6rem 0; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
ul { margin:.6rem 0; padding-left:1.25rem; } li { margin:.25rem 0; }
code { background:var(--code); padding:.12em .38em; border-radius:.35rem; font:.88em ui-monospace,SFMono-Regular,Menlo,monospace; }
pre { background:var(--code); border:1px solid var(--border); border-radius:.6rem; padding:1rem; overflow-x:auto; }
pre code { background:none; padding:0; }
.tagline { color:var(--muted); font-size:1.1rem; margin:.25rem 0 1.5rem; }
footer { color:var(--muted); font-size:.85rem; margin-top:4rem; border-top:1px solid var(--border); padding-top:1rem; }
`.trim();

/** Assemble the single-page site from the authored prose and generated reference. */
export function renderSite(sections: string[]): string {
  const body = sections.map(markdownToHtml).join("\n");
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
    "<main>",
    body,
    "<footer>Reference generated from the agentj source. Rebuild with <code>bun run docs</code>.</footer>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Prose pages, in site order. Reference is appended after them, generated. */
const CONTENT_ORDER = ["index.md"] as const;

/** The full set of files the generator owns, as {relativePath: contents}. */
export function buildOutputs(): Record<string, string> {
  const reference = renderReferenceMarkdown();
  const config = renderConfigMarkdown();
  const prose = CONTENT_ORDER.map((name) => readFileSync(join(CONTENT_DIR, name), "utf8"));
  return {
    "content/reference.generated.md": reference,
    "content/config.generated.md": config,
    "index.html": renderSite([...prose, reference, config]),
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
