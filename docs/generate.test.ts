import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DOCS } from "../core/lib/config/reference";
import {
  buildOutputs,
  markdownToHtml,
  renderCliMarkdown,
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
    expect(reference).toContain("`/build` — Approve the plan and build it");
    expect(reference).toContain("Ctrl+V — paste copied files");
  });

  test("config reference pulls defaults from the schema for every documented key", () => {
    const config = renderConfigMarkdown();
    // Real key with its schema default and a non-default example.
    expect(config).toContain("`agent.steps` (default: `100`)");
    expect(config).toContain("`agent.context.softLimit` (default: unset)");
    for (const doc of CONFIG_DOCS) expect(config).toContain(`\`${doc.path}\``);
  });

  test("the CLI reference is sourced from the command definitions (flags and options)", () => {
    const cli = renderCliMarkdown();
    expect(cli).toContain("### `glorious run <task>`");
    expect(cli).toContain("`--allow-all` — Resolve permission asks to allow");
    // An option (value-taking), not just a boolean flag, so both categories are covered.
    expect(cli).toContain("`--resume <str>` — Resume a chat session by id.");
  });

  test("documenting a config key that does not exist fails the build", () => {
    expect(() =>
      renderConfigMarkdown([{ path: "agent.not.a.real.key", description: "x" }]),
    ).toThrow("unknown config path");
  });

  test("markdown renderer escapes HTML, adds heading ids, and handles the subset", () => {
    const { html, headings } = markdownToHtml(
      "# Title\n\nA **bold** `x<y` and [link](https://e.test).\n\n- one\n- two",
    );
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>x&lt;y</code>");
    expect(html).toContain('<a href="https://e.test">link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(headings).toEqual([{ level: 1, text: "Title", id: "title" }]);
  });

  test("fenced code blocks render verbatim and escaped", () => {
    expect(markdownToHtml("```\nglorious run <task>\n```").html).toBe(
      "<pre><code>glorious run &lt;task&gt;</code></pre>",
    );
  });

  test("repeated headings get unique ids so the nav anchors never collide", () => {
    const { headings } = markdownToHtml("# Config\n\n## Config\n\n# Config");
    expect(headings.map((h) => h.id)).toEqual(["config", "config-2", "config-3"]);
  });

  test("the site builds a table of contents from its own headings", () => {
    const { headings } = markdownToHtml(buildOutputs()["content/reference.generated.md"] ?? "");
    const site = buildOutputs()["index.html"] ?? "";
    // Every h1/h2 in the content is linkable from the sticky nav.
    expect(site).toContain('<nav class="toc"');
    for (const h of headings) expect(site).toContain(`href="#${h.id}"`);
  });

  test(":::details blocks become collapsible disclosures", () => {
    const { html } = markdownToHtml(":::details More\n\nhidden text\n\n:::");
    expect(html).toContain("<details><summary>More</summary>");
    expect(html).toContain("<p>hidden text</p>");
    expect(html).toContain("</details>");
  });

  test("headings inside a disclosure stay out of the nav (they start collapsed)", () => {
    const { headings } = markdownToHtml("## Visible\n\n:::details Advanced\n\n## Buried\n\n:::");
    expect(headings.map((h) => h.text)).toEqual(["Visible"]);
  });

  test("an unterminated disclosure is closed so the HTML stays well-formed", () => {
    const { html } = markdownToHtml(":::details Oops\n\ncontent");
    expect(html.match(/<details>/g)?.length).toBe(1);
    expect(html.match(/<\/details>/g)?.length).toBe(1);
  });
});
