// The interactive slash commands — one registry shared by the line reader (highlight + Tab completion)
// and the chat loop (dispatch), so "known commands" means the same thing in both places.

export interface SlashCommand {
  /** Including the leading slash, e.g. "/task". */
  name: string;
  /** True if the command expects an argument after it (Tab completes it with a trailing space). */
  takesArg: boolean;
  /** One line shown when Tab lists ambiguous matches. */
  summary: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/task", takesArg: true, summary: "wipe + re-key the worktree onto a PR or branch, then start a fresh task" },
  { name: "/exit", takesArg: false, summary: "quit agentj" },
  { name: "/quit", takesArg: false, summary: "quit agentj" },
];
