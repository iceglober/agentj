import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  composeSkillsPromptSection,
  discoverSkills,
  embeddedSkillsRoot,
  parseSkillMarkdown,
  renderSkillInvocation,
  type Skill,
  type SkillFileSystem,
  skillMode,
} from "./index";

const skillSource = (frontmatter: string, body = "Do the thing."): string =>
  `---\n${frontmatter}\n---\n\n${body}\n`;

const makeSkill = (overrides: Partial<Skill> = {}): Skill => ({
  name: "ship",
  description: "Ship finished work.",
  path: "/repo/.glorious/skills/ship/SKILL.md",
  dir: "/repo/.glorious/skills/ship",
  body: "Open a PR.",
  userInvocable: true,
  metadata: {},
  ...overrides,
});

describe("parseSkillMarkdown", () => {
  test("parses spec frontmatter including quoted values and a metadata block", () => {
    const parsed = parseSkillMarkdown(
      skillSource(
        [
          "name: pdf-processing",
          'description: "Extract PDF text. Use when handling PDFs."',
          "license: Apache-2.0",
          "metadata:",
          "  author: example-org",
          '  version: "1.0"',
          "  glorious-mode: build",
        ].join("\n"),
        "Step one.\n\nStep two.",
      ),
    );
    expect(parsed).toEqual({
      name: "pdf-processing",
      description: "Extract PDF text. Use when handling PDFs.",
      userInvocable: true,
      metadata: { author: "example-org", version: "1.0", "glorious-mode": "build" },
      body: "Step one.\n\nStep two.",
    });
  });

  test("rejects missing frontmatter, bad names, and empty descriptions", () => {
    expect(parseSkillMarkdown("just a body")).toEqual({
      detail: "SKILL.md must start with YAML frontmatter (--- fences)",
    });
    for (const name of ["PDF-Processing", "-pdf", "pdf--processing", "pdf-"]) {
      const result = parseSkillMarkdown(skillSource(`name: ${name}\ndescription: Valid.`));
      expect(result).toHaveProperty("detail");
      expect((result as { detail: string }).detail).toContain("name");
    }
    expect(parseSkillMarkdown(skillSource("name: ship\ndescription:"))).toHaveProperty("detail");
    expect(parseSkillMarkdown(skillSource("name: ship"))).toHaveProperty("detail");
  });

  test("parses user-invocable as a boolean and rejects string values", () => {
    expect(
      parseSkillMarkdown(skillSource("name: ship\ndescription: Ship.\nuser-invocable: false")),
    ).toMatchObject({ name: "ship", userInvocable: false });
    expect(
      parseSkillMarkdown(skillSource('name: ship\ndescription: Ship.\nuser-invocable: "false"')),
    ).toEqual({
      detail:
        "invalid frontmatter — user-invocable: Invalid input: expected boolean, received string",
    });
  });

  test("rejects an unknown glorious-mode while tolerating unknown top-level fields", () => {
    expect(
      parseSkillMarkdown(
        skillSource("name: ship\ndescription: Ship.\nmetadata:\n  glorious-mode: yolo"),
      ),
    ).toEqual({ detail: "invalid frontmatter — metadata.glorious-mode: use plan or build" });
    const parsed = parseSkillMarkdown(
      skillSource("name: ship\ndescription: Ship.\ncompatibility: Requires git and gh"),
    );
    expect(parsed).toMatchObject({ name: "ship" });
  });

  test("a frontmatter-only file yields an empty body", () => {
    expect(parseSkillMarkdown("---\nname: ship\ndescription: Ship.\n---")).toMatchObject({
      body: "",
    });
  });
});

describe("discoverSkills", () => {
  const fixture = (files: Record<string, string>): SkillFileSystem => ({
    listDirectories: async (path) => {
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(`${path}/`)) continue;
        const name = file.slice(path.length + 1).split("/")[0];
        if (name && file.includes("/", path.length + 1 + name.length)) names.add(name);
      }
      return [...names].sort();
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  });

  test("earlier roots win name collisions and issues never block other skills", async () => {
    const fileSystem = fixture({
      "/project/.glorious/skills/ship/SKILL.md": skillSource(
        "name: ship\ndescription: Project ship flow.",
      ),
      "/project/.glorious/skills/broken/SKILL.md": "no frontmatter",
      "/project/.glorious/skills/renamed/SKILL.md": skillSource(
        "name: other\ndescription: Name mismatch.",
      ),
      "/global/skills/ship/SKILL.md": skillSource("name: ship\ndescription: Global ship flow."),
      "/global/skills/review/SKILL.md": skillSource("name: review\ndescription: Review changes."),
    });
    const { skills, issues } = await discoverSkills({
      roots: ["/project/.glorious/skills", "/global/skills"],
      fileSystem,
    });
    expect(skills.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "ship", description: "Project ship flow." },
      { name: "review", description: "Review changes." },
    ]);
    expect(skills[0]).toMatchObject({
      path: "/project/.glorious/skills/ship/SKILL.md",
      dir: "/project/.glorious/skills/ship",
    });
    expect(issues).toEqual([
      {
        path: "/project/.glorious/skills/broken/SKILL.md",
        detail: "SKILL.md must start with YAML frontmatter (--- fences)",
      },
      {
        path: "/project/.glorious/skills/renamed/SKILL.md",
        detail: 'name "other" must match its directory "renamed"',
      },
    ]);
  });

  test("a skill directory without SKILL.md is an issue; a missing root is empty", async () => {
    const fileSystem = fixture({ "/project/.glorious/skills/empty/notes.txt": "x" });
    const { skills, issues } = await discoverSkills({
      roots: ["/project/.glorious/skills", "/nowhere"],
      fileSystem,
    });
    expect(skills).toEqual([]);
    expect(issues).toEqual([
      { path: "/project/.glorious/skills/empty/SKILL.md", detail: "missing SKILL.md" },
    ]);
  });

  test("discovers from the real filesystem adapter", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "aj-skills-"));
    try {
      await mkdir(join(root, "ship"), { recursive: true });
      await writeFile(
        join(root, "ship", "SKILL.md"),
        skillSource("name: ship\ndescription: Ship it."),
      );
      const { skills, issues } = await discoverSkills({ roots: [root] });
      expect(issues).toEqual([]);
      expect(skills).toMatchObject([{ name: "ship", dir: join(root, "ship") }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ships embedded model-only skills through the normal discovery path", async () => {
    const expectedNames = ["creating-agent-skills", "running-background-work", "using-the-browser"];
    const { skills, issues } = await discoverSkills({ roots: [embeddedSkillsRoot] });
    expect(issues).toEqual([]);
    expect(skills.map((skill) => skill.name)).toEqual(expectedNames);
    for (const skill of skills) expect(skill.userInvocable).toBe(false);
  });
});

describe("invocation and prompt section", () => {
  test("substitutes $ARGUMENTS when present, appends arguments otherwise", () => {
    const templated = makeSkill({ body: "Ship with focus: $ARGUMENTS. Then verify $ARGUMENTS." });
    expect(renderSkillInvocation(templated, " fix ci ")).toContain(
      "Ship with focus: fix ci. Then verify fix ci.",
    );
    expect(renderSkillInvocation(makeSkill(), "fast please")).toContain(
      "Open a PR.\n\nArguments: fast please",
    );
    const bare = renderSkillInvocation(makeSkill(), "  ");
    expect(bare).not.toContain("Arguments:");
    expect(bare).toContain('Skill "ship" invoked');
    expect(bare).toContain("/repo/.glorious/skills/ship");
  });

  test("prompt section lists model-eligible skills regardless of user invocation", () => {
    const nonInvocable = makeSkill({
      name: "background-work",
      description: "Continue work after this turn.",
      userInvocable: false,
    });
    const section = composeSkillsPromptSection([makeSkill(), nonInvocable]);
    expect(section).toContain("- background-work — Continue work after this turn.");
    expect(section).toContain("some skills explicitly as /<name>");
  });

  test("prompt section lists eligible skills and omits disabled ones", () => {
    const section = composeSkillsPromptSection([
      makeSkill(),
      makeSkill({
        name: "secret",
        description: "User-only.",
        metadata: { "glorious-model-invocation": "disabled" },
      }),
    ]);
    expect(section).toContain("# Skills");
    expect(section).toContain(
      "- ship — Ship finished work. (/repo/.glorious/skills/ship/SKILL.md)",
    );
    expect(section).not.toContain("secret");
    expect(composeSkillsPromptSection([])).toBe("");
  });

  test("skillMode reads the glorious-mode metadata key", () => {
    expect(skillMode(makeSkill())).toBeUndefined();
    expect(skillMode(makeSkill({ metadata: { "glorious-mode": "build" } }))).toBe("build");
  });
});
