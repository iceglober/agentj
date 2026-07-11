// Desktop-native slash-command registry + a small fuzzy matcher. The input's
// command palette renders from `COMMANDS`; App owns dispatch via runCommand.

export interface Command {
  id: string;
  name: string; // includes the leading slash, e.g. "/mcp"
  description: string;
}

export const COMMANDS: Command[] = [
  { id: "init", name: "/init", description: "Map this repo & write AGENTS.md" },
  { id: "mcp", name: "/mcp", description: "Show tool & MCP status" },
  { id: "new", name: "/new", description: "New worktree session" },
  { id: "close", name: "/close", description: "Close this session" },
  { id: "settings", name: "/settings", description: "Open settings" },
  { id: "config", name: "/config", description: "Edit project config (.aj hooks, aj.json, .mcp.json)" },
  { id: "shortcuts", name: "/shortcuts", description: "Keyboard shortcuts" },
  { id: "clear", name: "/clear", description: "Clear this transcript" },
];

// Subsequence fuzzy score: every char of `query` must appear in order within
// `target`. Higher is better; contiguous runs and early matches score more.
// Returns null when there's no subsequence match.
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) {
        found = j;
        break;
      }
    }
    if (found === -1) return null;
    if (found === prevMatch + 1) score += 3; // contiguous run
    if (found === 0) score += 2; // match at start
    score += Math.max(0, 5 - found); // earlier is better
    prevMatch = found;
    ti = found + 1;
  }
  return score;
}

// Fuzzy-match the typed slash token (e.g. "/mc") against command names.
// Matches on the name (slash stripped) and falls back to the description.
export function matchCommands(input: string, list: Command[] = COMMANDS): Command[] {
  const query = input.replace(/^\//, "").trim();
  if (query.length === 0) return list;
  const scored: { cmd: Command; score: number }[] = [];
  for (const cmd of list) {
    const nameScore = fuzzyScore(query, cmd.name.replace(/^\//, ""));
    const descScore = fuzzyScore(query, cmd.description);
    let best: number | null = null;
    if (nameScore !== null) best = nameScore + 10; // prefer name hits
    if (descScore !== null) best = Math.max(best ?? -Infinity, descScore);
    if (best !== null) scored.push({ cmd, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
}

// Is `text` exactly one known command name (trimmed)?
export function isCommandName(text: string, list: Command[] = COMMANDS): boolean {
  const t = text.trim();
  return list.some((c) => c.name === t);
}
