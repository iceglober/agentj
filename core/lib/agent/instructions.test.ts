import { expect, test } from "bun:test";
import type { Sandbox } from "../sandbox";
import {
  composeInstructionLayers,
  type InstructionExtension,
  loadInstructionExtensions,
} from "./instructions";

const sandbox = (files: Record<string, string>): Sandbox =>
  ({
    readFile: async (path: string) => {
      if (!(path in files)) throw new Error("missing");
      return files[path];
    },
  }) as Sandbox;

test("instruction extensions apply only in their configured scope", async () => {
  const extensions: Record<string, InstructionExtension> = {
    plan: {
      path: ".glorious/extensions/plan.md",
      modes: ["plan"],
      roles: ["primary"],
      required: true,
    },
  };
  expect(
    await loadInstructionExtensions(
      sandbox({ ".glorious/extensions/plan.md": "plan policy" }),
      extensions,
      { mode: "plan", role: "primary" },
    ),
  ).toBe("plan policy");
  expect(
    await loadInstructionExtensions(sandbox({}), extensions, { mode: "build", role: "primary" }),
  ).toBe("");
  expect(
    await loadInstructionExtensions(sandbox({}), extensions, { mode: "plan", role: "delegate" }),
  ).toBe("");
});

test("optional missing extensions are ignored and required ones fail", async () => {
  expect(
    await loadInstructionExtensions(
      sandbox({}),
      { optional: { path: "missing.md", modes: ["plan"], roles: ["primary"], required: false } },
      { mode: "plan", role: "primary" },
    ),
  ).toBe("");
  await expect(
    loadInstructionExtensions(
      sandbox({}),
      { required: { path: "missing.md", modes: ["plan"], roles: ["primary"], required: true } },
      { mode: "plan", role: "primary" },
    ),
  ).rejects.toThrow("Required instruction extension required");
});

test("instruction layers trim empty values and preserve order", () => {
  expect(composeInstructionLayers([" AGENTS ", "", "rules", " extension "])).toBe(
    "AGENTS\n\nrules\n\nextension",
  );
});
