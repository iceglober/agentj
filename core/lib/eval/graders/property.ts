import type { CheckGrader } from "../types";

/** An added line in a unified diff: starts with `+` but is not the `+++` header. */
function isAddedLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

/** An added/removed content line (excludes `+++`/`---` headers). */
function isChangeLine(line: string): boolean {
  return (
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))
  );
}

/** Path from a `+++ b/path` header (strips the `a/`|`b/` prefix). */
function newFilePath(line: string): string | null {
  if (!line.startsWith("+++ ")) return null;
  const raw = line.slice(4).trim();
  return raw.replace(/^[ab]\//, "");
}

export const gradeNoPlaceholder: CheckGrader = async (_env, _task, traj, check) => {
  if (check.kind !== "no_placeholder") throw new Error("wrong grader");
  for (const line of traj.finalDiff.split("\n")) {
    if (!isAddedLine(line)) continue;
    const hit = check.patterns.find((p) => line.includes(p));
    if (hit)
      return { pass: false, detail: `added line contains "${hit}": ${line.slice(1).trim()}` };
  }
  return { pass: true, detail: "no placeholder markers in added lines" };
};

export const gradeNoNewDeps: CheckGrader = async (_env, _task, traj, check) => {
  if (check.kind !== "no_new_deps") throw new Error("wrong grader");
  // Property probe, not a parser: track the current file from diff headers and
  // flag added lines in a manifest that look like a dependency entry.
  let current: string | null = null;
  for (const line of traj.finalDiff.split("\n")) {
    const p = newFilePath(line);
    if (p !== null) {
      current = p;
      continue;
    }
    if (current === null || !isAddedLine(line)) continue;
    const inManifest = check.manifests.some((m) => current === m || current!.endsWith(`/${m}`));
    if (!inManifest) continue;
    const body = line.slice(1).trim();
    // package.json style `"name": "^1.0.0"` or a bare requirement line.
    const looksLikeDep = /"[^"]+"\s*:\s*"/.test(body) || /^[A-Za-z0-9._-]+\s*[=<>~!]=/.test(body);
    if (looksLikeDep)
      return { pass: false, detail: `possible new dependency in ${current}: ${body}` };
  }
  return { pass: true, detail: "no new dependency lines detected" };
};

export const gradeReportContains: CheckGrader = async (_env, _task, traj, check) => {
  if (check.kind !== "report_contains") throw new Error("wrong grader");
  const report = traj.finalText.toLowerCase();
  const missing = check.contains.filter((s) => !report.includes(s.toLowerCase()));
  const pass = missing.length === 0;
  return {
    pass,
    detail: pass
      ? `report covers all ${check.contains.length} expected point(s)`
      : `report missing: ${missing.map((s) => `"${s}"`).join(", ")}`,
  };
};

export const gradeToolUsage: CheckGrader = async (_env, _task, traj, check) => {
  if (check.kind !== "tool_usage") throw new Error("wrong grader");
  const count = traj.toolCalls.filter((c) => c.name === check.tool).length;
  const pass = count >= check.min && (check.max === undefined || count <= check.max);
  const bound = check.max === undefined ? `>=${check.min}` : `${check.min}..${check.max}`;
  return { pass, detail: `"${check.tool}" called ${count} time(s), wanted ${bound}` };
};

export const gradeDiffSize: CheckGrader = async (_env, _task, traj, check) => {
  if (check.kind !== "diff_size") throw new Error("wrong grader");
  let changed = 0;
  for (const line of traj.finalDiff.split("\n")) if (isChangeLine(line)) changed++;
  const pass = changed <= check.maxChangedLines;
  return {
    pass,
    detail: `${changed} changed line(s) vs limit ${check.maxChangedLines}`,
  };
};
