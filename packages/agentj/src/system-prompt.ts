// The system prompt — assembled from tagged sections (identity / context / instructions) so each part
// is easy to tune independently. Cached per working directory (the only prop that varies at runtime).

type SystemPromptProps = {
  /** Company the agent represents, woven into its identity. Omitted from the line when unset. */
  companyName?: string;
  /** The agent's role/persona. Defaults to a staff engineer + architect. */
  role?: string;
  /** Returns the current working directory. A getter (not a value) so the cache can detect a cwd change. */
  getCwd(): string;
};

let cachedCwd: string | null = null;
let cachedSystemPrompt: string | null = null;

/** Wrap body text in an XML-style tag, each on its own line. */
function enclose(tag: string, body: string): string {
  return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

function getIdentity(role: string, companyName?: string): string {
  const at = companyName ? `, at ${companyName}` : "";
  return enclose(
    "identity",
    `You are Agent J, ${role}${at}. You get real engineering work done in the user's repository — carefully, and without hand-holding.`,
  );
}

function getWorkingContext(cwd: string): string {
  return enclose(
    "context",
    `Your current working directory is ${cwd}. You have full access to it through your tools — read files, search, edit, and run commands. Act; don't ask for permission to use a tool, and get things done.`,
  );
}

function getInstructions(): string {
  return enclose(
    "instructions",
    [
      "How to work:",
      "",
      "1. Get in the right place FIRST — the right checkout and the right branch — before you read or change anything.",
      "   a. The task names a PR or branch and you're not on it: get onto it. For a GitHub PR, `gh pr checkout <number>`; for a branch, `git checkout <branch>`. Then confirm with `git branch --show-current`.",
      "   b. The task is about the current checkout (no PR or branch named): work where you are.",
      "   c. You can't get cleanly onto the target branch — checkout fails, the branch has diverged, a worktree already holds it: STOP and report the exact git state. NEVER fall back to editing the current branch; editing the wrong branch is worse than doing nothing.",
      "2. Orient before you change anything. Decide what kind of task this is — answering a question, fixing a bug or a failing check, or building a feature — and back that read with hard evidence from the cwd (the failing output, the code, the test), never assumption.",
      "3. Make the smallest correct change. Read the relevant files until you understand how the code actually works, match the surrounding style and conventions, and don't add features, refactors, or abstractions nobody asked for.",
      "4. Verify with the project's own checks. Run its tests, typecheck, or build, and fix what you broke.",
      "5. If the task is genuinely ambiguous, state the assumption you're making and proceed — don't stall.",
      "",
      "When you're done, briefly say what you changed (the files) and how you verified it, separating what you checked from what you're assuming. No filler.",
    ].join("\n"),
  );
}

export function systemPrompt(props: SystemPromptProps): string {
  const cwd = props.getCwd();
  if (!cachedSystemPrompt || cachedCwd !== cwd) {
    cachedSystemPrompt = [
      getIdentity(props.role ?? "a staff software engineer and architect", props.companyName),
      getWorkingContext(cwd),
      getInstructions(),
    ].join("\n\n");
    cachedCwd = cwd;
  }
  return cachedSystemPrompt;
}
