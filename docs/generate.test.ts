import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DOCS } from "./content/config-reference";
import {
  buildOutputs,
  markdownToHtml,
  renderConfigMarkdown,
  renderReferenceMarkdown,
} from "./generate";

const DOCS_DIR = new URL(".", import.meta.url).pathname;
const read = (relative: string): string => readFileSync(join(DOCS_DIR, relative), "utf8");

describe("docs generator", () => {
  test("committed docs match a fresh render — run `bun run docs` if this fails", () => {
    for (const [path, contents] of Object.entries(buildOutputs())) {
      expect(`${path}:\n${read(path)}`).toBe(`${path}:\n${contents}`);
    }
  });

  test("the reference is sourced from the live command registry", () => {
    const reference = renderReferenceMarkdown();
    // A representative command and a key line, so a rename in the registry that
    // skipped regeneration is caught here too, not only by the byte pin above.
    expect(reference).toContain("`/build` — Switch to build mode");
    expect(reference).toContain("Ctrl+V — paste copied files");
  });

  test("config reference pulls defaults from the schema for every documented key", () => {
    const config = renderConfigMarkdown();
    // Real key with its schema default and a non-default example.
    expect(config).toContain("`agent.steps` (default: `100`)");
    expect(config).toContain("`agent.context.softLimit` (default: unset)");
    for (const doc of CONFIG_DOCS) expect(config).toContain(`\`${doc.path}\``);
  });

  test("documenting a config key that does not exist fails the build", () => {
    expect(() =>
      renderConfigMarkdown([{ path: "agent.not.a.real.key", description: "x" }]),
    ).toThrow("unknown config path");
  });

  test("markdown renderer escapes HTML and handles the authored subset", () => {
    const html = markdownToHtml(
      "# Title\n\nA **bold** `x<y` and [link](https://e.test).\n\n- one\n- two",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>x&lt;y</code>");
    expect(html).toContain('<a href="https://e.test">link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
  });

  test("fenced code blocks render verbatim and escaped", () => {
    expect(markdownToHtml("```\nagentj run <task>\n```")).toBe(
      "<pre><code>agentj run &lt;task&gt;</code></pre>",
    );
  });
});
