// Input layer — a minimal line reader, no third-party deps (self-contained).
//
// On a TTY it owns stdin in raw mode: auto-echo is off, so keystrokes typed while the agent streams
// can't garble the output (we only echo while actively reading). It redraws the whole line on each
// keystroke, which lets it HIGHLIGHT a recognized slash command (cyan) vs an unknown one (red), and
// Tab-COMPLETES a partial command. Off a TTY (pipes, tests) it falls back to plain line reading with
// no highlight. The terminal is always restored — on close() and on process exit.

import type { SlashCommand } from "./commands.ts";

/** Why a read returned null — lets the caller treat a Ctrl-C bail differently from EOF. */
export type EndReason = "ctrl-c" | "ctrl-d" | "eof";

export interface LineReader {
  /** Prompt and read one line. Resolves to the line, or null on Ctrl-C / Ctrl-D / EOF. */
  read(promptStr: string): Promise<string | null>;
  /** Why the most recent read resolved null. Undefined after a normal line. */
  readonly endReason?: EndReason;
  /** Restore the terminal and stop reading. */
  close(): void;
}

export interface LineReaderOptions {
  /** Known slash commands — enables highlight + Tab completion (TTY only). */
  commands?: SlashCommand[];
}

export function createLineReader(opts: LineReaderOptions = {}): LineReader {
  return process.stdin.isTTY ? rawReader(opts.commands ?? []) : cookedReader();
}

const ENTER = new Set(["\r", "\n"]);
const CTRL_C = 3;
const CTRL_D = 4;
const TAB = 9;
const BACKSPACE = new Set([8, 127]);
const ESC = 27;

// ── highlight + completion (pure, exported for tests) ──

const FG_RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const DIM = "\x1b[90m";

/** The command token (before the first space) and the remainder of the line. */
function splitCommand(line: string): { token: string; rest: string } {
  const sp = line.indexOf(" ");
  return sp === -1 ? { token: line, rest: "" } : { token: line.slice(0, sp), rest: line.slice(sp) };
}

/**
 * Render a line for display: if it's a slash command, color the command token — cyan+bold for an
 * exact known command, cyan for a valid prefix of one, red for an unknown `/…`. Non-command text is
 * returned unchanged, and the remainder after the command is left plain.
 */
export function renderLine(line: string, commands: SlashCommand[]): string {
  if (!line.startsWith("/") || commands.length === 0) return line;
  const { token, rest } = splitCommand(line);
  if (commands.some((c) => c.name === token)) return `${BOLD}${CYAN}${token}${BOLD_OFF}${FG_RESET}${rest}`;
  if (commands.some((c) => c.name.startsWith(token))) return `${CYAN}${token}${FG_RESET}${rest}`;
  return `${RED}${token}${FG_RESET}${rest}`;
}

/** Longest common prefix of a set of strings (for Tab completing to the shared stem). */
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let p = strs[0];
  for (const s of strs) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/**
 * Compute a Tab completion for `line`. Only completes the command token (before any space). Returns
 * the (possibly) extended line, plus `candidates` when the match is ambiguous and can't be extended
 * further (so the caller can list them). No match / not a command ⇒ line unchanged.
 */
export function completeCommand(line: string, commands: SlashCommand[]): { line: string; candidates?: SlashCommand[] } {
  if (!line.startsWith("/") || line.includes(" ")) return { line };
  const matches = commands.filter((c) => c.name.startsWith(line));
  if (matches.length === 0) return { line };
  if (matches.length === 1) return { line: matches[0].name + (matches[0].takesArg ? " " : "") };
  const lcp = longestCommonPrefix(matches.map((m) => m.name));
  return lcp.length > line.length ? { line: lcp } : { line, candidates: matches };
}

function rawReader(commands: SlashCommand[]): LineReader {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let closed = false;
  let endReason: EndReason | undefined;
  const restore = () => {
    if (closed) return;
    closed = true;
    try {
      stdin.setRawMode(false);
    } catch {
      // terminal already gone
    }
    stdin.pause();
  };
  process.once("exit", restore);

  return {
    get endReason() {
      return endReason;
    },
    read(promptStr: string): Promise<string | null> {
      return new Promise((resolve) => {
        endReason = undefined;
        let line = "";
        // Split the prompt so the leading newline(s) print once and only the tail (e.g. "› ") is
        // reprinted on each redraw.
        const nl = promptStr.lastIndexOf("\n");
        const leading = promptStr.slice(0, nl + 1);
        const tail = promptStr.slice(nl + 1);
        const redraw = () => process.stdout.write(`\r\x1b[K${tail}${renderLine(line, commands)}`);

        process.stdout.write(leading);
        redraw();

        const finish = (val: string | null, reason?: EndReason) => {
          endReason = reason;
          process.stdout.write("\n");
          stdin.off("data", onData);
          resolve(val);
        };

        const onData = (data: string) => {
          let changed = false;
          for (const ch of data) {
            const code = ch.codePointAt(0) ?? 0;
            if (ENTER.has(ch)) return finish(line);
            if (code === CTRL_C || (code === CTRL_D && line === "")) return finish(null, code === CTRL_C ? "ctrl-c" : "ctrl-d");
            if (code === TAB) {
              const { line: next, candidates } = completeCommand(line, commands);
              line = next;
              if (candidates) {
                process.stdout.write(`\n${candidates.map((c) => `  ${CYAN}${c.name}${FG_RESET}  ${DIM}${c.summary}${FG_RESET}`).join("\n")}\n`);
              }
              redraw();
              changed = false;
              continue;
            }
            if (BACKSPACE.has(code)) {
              if (line.length > 0) {
                line = line.slice(0, -1);
                changed = true;
              }
              continue;
            }
            if (code === ESC) break; // drop escape sequences (arrows etc.) for now
            if (code < 32) continue; // ignore other control chars
            line += ch;
            changed = true;
          }
          if (changed) redraw();
        };
        stdin.on("data", onData);
      });
    },
    close: restore,
  };
}

/** Plain line reader for non-TTY stdin (pipes, tests): buffer data, split on newlines. No highlight. */
function cookedReader(): LineReader {
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let buffer = "";
  let ended = false;
  const ready: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let endReason: EndReason | undefined;

  stdin.on("data", (d: string) => {
    buffer += d;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(line);
      } else {
        ready.push(line);
      }
    }
  });
  stdin.on("end", () => {
    ended = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(null);
    }
  });

  return {
    get endReason() {
      return endReason;
    },
    read(promptStr: string): Promise<string | null> {
      process.stdout.write(promptStr);
      return new Promise((resolve) => {
        if (ready.length > 0) return resolve(ready.shift() ?? null);
        if (ended) {
          endReason = "eof";
          return resolve(null);
        }
        endReason = undefined;
        waiting = (line) => {
          if (line === null) endReason = "eof";
          resolve(line);
        };
      });
    },
    close() {
      stdin.pause();
    },
  };
}
