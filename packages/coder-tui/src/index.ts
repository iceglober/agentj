// coder-tui — host-side client entry. `bin/coder` calls `main()`.
//
// The cockpit: orchestrates the worktree + per-worktree container + tmux (chat pane L,
// real shell pane R), then mounts the Ink chat client connected to the sandboxed agent
// server over SSE. P0 is the substrate; the Ink UI ships in P2 (see docs/PLAN.md).
import { Routes } from "coder-core";

const VERSION = "0.0.0";

const HELP = `coder — a coding agent that computes over inferring.

USAGE
  coder [options]
  coder --once "<task>"     run one task headless (P1)

OPTIONS
  -h, --help       show this help
  -v, --version    print version

This is the P0 scaffold. The chat TUI + / palette + shell pane land in P2.
See docs/PLAN.md for the full design and phases.`;

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(VERSION);
    return;
  }

  const onceIdx = argv.indexOf("--once");
  if (onceIdx !== -1) {
    const task = argv[onceIdx + 1];
    // TODO(P1): ensure worktree+container, start coder-server, drive one turn headless.
    console.error(`[coder] --once not implemented yet (P1). Task was: ${task ?? "(none)"}`);
    console.error(`[coder] server health route: ${Routes.health}`);
    process.exitCode = 1;
    return;
  }

  // TODO(P0/P2): preflight (tty/docker/tmux, reject nested tmux) → ensure worktree +
  // container → tmux split → mount Ink chat (pane L) beside docker-exec shell (pane R).
  console.log(HELP);
}
