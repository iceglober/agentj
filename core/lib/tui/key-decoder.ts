import type { EditorCommand } from "./editor";

const ESCAPE = "\u001b";
const PASTE_START = `${ESCAPE}[200~`;
const PASTE_END = `${ESCAPE}[201~`;

interface Modifiers {
  shift: boolean;
  alt: boolean;
  control: boolean;
  super: boolean;
}

const modifiersFromParameter = (parameter: string | undefined): Modifiers => {
  const encoded = Number.parseInt(parameter?.split(":")[0] ?? "1", 10);
  const bits = Number.isFinite(encoded) ? Math.max(0, encoded - 1) : 0;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    control: (bits & 4) !== 0,
    super: (bits & 8) !== 0,
  };
};

const arrowCommand = (final: string, modifiers: Modifiers): EditorCommand | undefined => {
  if (final === "A") return { type: "move-up" };
  if (final === "B") return { type: "move-down" };
  if (final === "D") {
    if (modifiers.super) return { type: "move-line-start" };
    if (modifiers.alt) return { type: "move-word-left" };
    return { type: "move-left" };
  }
  if (final === "C") {
    if (modifiers.super) return { type: "move-line-end" };
    if (modifiers.alt) return { type: "move-word-right" };
    return { type: "move-right" };
  }
  if (final === "H") return { type: "move-line-start" };
  if (final === "F") return { type: "move-line-end" };
  return undefined;
};

const modifiedBackspace = (modifiers: Modifiers): EditorCommand => {
  if (modifiers.super) return { type: "delete-line-backward" };
  if (modifiers.alt) return { type: "delete-word-backward" };
  return { type: "delete-backward" };
};

const modifiedDelete = (modifiers: Modifiers): EditorCommand => {
  if (modifiers.super) return { type: "delete-line-forward" };
  if (modifiers.alt) return { type: "delete-word-forward" };
  return { type: "delete-forward" };
};

const decodeCsi = (parameters: string, final: string): EditorCommand | undefined => {
  const parts = parameters.split(";");
  const modifiers = modifiersFromParameter(parts[1]);

  const arrow = arrowCommand(final, modifiers);
  if (arrow) return arrow;

  if (final === "u") {
    const key = Number.parseInt(parts[0]?.split(":")[0] ?? "", 10);
    if (key === 13) return modifiers.shift ? { type: "newline" } : { type: "submit" };
    if (key === 8 || key === 127) return modifiedBackspace(modifiers);
    if (key === 57349) return modifiedDelete(modifiers);
    if (key === 57350) return arrowCommand("D", modifiers);
    if (key === 57351) return arrowCommand("C", modifiers);
    if (key === 57352) return arrowCommand("A", modifiers);
    if (key === 57353) return arrowCommand("B", modifiers);
    if (key === 57356) return { type: "move-line-start" };
    if (key === 57357) return { type: "move-line-end" };
    return undefined;
  }

  if (final !== "~") return undefined;

  const key = Number.parseInt(parts[0] ?? "", 10);
  if (key === 27 && parts.length >= 3) {
    const modified = modifiersFromParameter(parts[1]);
    const code = Number.parseInt(parts[2] ?? "", 10);
    if (code === 13) return modified.shift ? { type: "newline" } : { type: "submit" };
    if (code === 8 || code === 127) return modifiedBackspace(modified);
  }
  if (key === 13) return modifiers.shift ? { type: "newline" } : { type: "submit" };
  if (key === 1 || key === 7) return { type: "move-line-start" };
  if (key === 4 || key === 8) return { type: "move-line-end" };
  if (key === 3) return modifiedDelete(modifiers);
  return undefined;
};

const decodeControl = (character: string): EditorCommand | undefined => {
  switch (character) {
    case "\r":
      return { type: "submit" };
    case "\n":
      return { type: "newline" };
    case "\t":
      return { type: "tab" };
    case "\u0003":
    case "\u0004":
      return { type: "cancel" };
    case "\u0001":
      return { type: "move-line-start" };
    case "\u0005":
      return { type: "move-line-end" };
    case "\u0015":
      return { type: "delete-line-backward" };
    case "\u000b":
      return { type: "delete-line-forward" };
    case "\u0002":
      return { type: "move-left" };
    case "\u0006":
      return { type: "move-right" };
    case "\u0010":
      return { type: "move-up" };
    case "\u000e":
      return { type: "move-down" };
    case "\b":
    case "\u007f":
      return { type: "delete-backward" };
    default:
      return undefined;
  }
};

const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
};

export class TerminalKeyDecoder {
  private readonly textDecoder = new TextDecoder();
  private pending = "";
  private pasted = false;
  private pastedCarriageReturn = false;

  push(chunk: string | Uint8Array): EditorCommand[] {
    this.pending +=
      typeof chunk === "string" ? chunk : this.textDecoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  end(): EditorCommand[] {
    this.pending += this.textDecoder.decode();
    return this.drain(true);
  }

  /** True while the buffer holds exactly a bare ESC awaiting a continuation. */
  get pendingLoneEscape(): boolean {
    return this.pending === ESCAPE;
  }

  /**
   * Resolve a bare ESC that never got its continuation (the caller arms a
   * short timer after push() when pendingLoneEscape is set): emits `escape`.
   */
  flush(): EditorCommand[] {
    if (!this.pendingLoneEscape) return [];
    this.pending = "";
    return [{ type: "escape" }];
  }

  private drain(ending: boolean): EditorCommand[] {
    const commands: EditorCommand[] = [];

    while (this.pending.length > 0) {
      if (this.pasted) {
        const end = this.pending.indexOf(PASTE_END);
        if (end === -1) {
          const retained = ending ? 0 : Math.min(PASTE_END.length - 1, this.pending.length);
          const available = this.pending.slice(0, this.pending.length - retained);
          this.pending = this.pending.slice(this.pending.length - retained);
          this.pushPasted(available, commands);
          break;
        }
        this.pushPasted(this.pending.slice(0, end), commands);
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.pasted = false;
        this.pastedCarriageReturn = false;
        continue;
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasted = true;
        this.pastedCarriageReturn = false;
        continue;
      }

      if (this.pending.startsWith("\r\n")) {
        this.pending = this.pending.slice(2);
        commands.push({ type: "newline" });
        continue;
      }

      const character = [...this.pending][0] ?? "";
      if (character !== ESCAPE) {
        this.pending = this.pending.slice(character.length);
        const control = decodeControl(character);
        if (control) commands.push(control);
        else if (!isControl(character)) commands.push({ type: "insert", text: character });
        continue;
      }

      if (this.pending.length === 1 && !ending) break;

      if (this.pending.startsWith(`${ESCAPE}[`)) {
        let finalIndex = -1;
        for (let index = 2; index < this.pending.length; index += 1) {
          const code = this.pending.charCodeAt(index);
          if (code >= 0x40 && code <= 0x7e) {
            finalIndex = index;
            break;
          }
        }
        if (finalIndex === -1 && !ending) break;
        if (finalIndex === -1) {
          this.pending = this.pending.slice(1);
          continue;
        }
        const parameters = this.pending.slice(2, finalIndex).replace(/[ -/]/gu, "");
        const final = this.pending[finalIndex] ?? "";
        this.pending = this.pending.slice(finalIndex + 1);
        const command = decodeCsi(parameters, final);
        if (command) commands.push(command);
        continue;
      }

      if (this.pending.startsWith(`${ESCAPE}O`)) {
        if (this.pending.length < 3 && !ending) break;
        const final = this.pending[2] ?? "";
        this.pending = this.pending.slice(Math.min(3, this.pending.length));
        const command = arrowCommand(final, modifiersFromParameter(undefined));
        if (command) commands.push(command);
        continue;
      }

      const alternate = this.pending[1];
      if (alternate === undefined) {
        this.pending = "";
        continue;
      }
      if (alternate === ESCAPE) {
        // A retained bare ESC followed by a new escape sequence: drop the bare
        // ESC only, so the second ESC starts a fresh sequence next iteration.
        this.pending = this.pending.slice(1);
        continue;
      }
      this.pending = this.pending.slice(2);
      if (alternate === "b" || alternate === "B") commands.push({ type: "move-word-left" });
      else if (alternate === "f" || alternate === "F") commands.push({ type: "move-word-right" });
      else if (alternate === "d" || alternate === "D")
        commands.push({ type: "delete-word-forward" });
      else if (alternate === "\b" || alternate === "\u007f")
        commands.push({ type: "delete-word-backward" });
      else {
        const control = decodeControl(alternate);
        if (control) commands.push(control);
        else if (!isControl(alternate)) commands.push({ type: "insert", text: alternate });
      }
    }

    return commands;
  }

  /** True while inside a bracketed paste whose end marker hasn't arrived —
   *  the screen coalesces paste spans until this drops back to false. */
  get midPaste(): boolean {
    return this.pasted;
  }

  private pushPasted(value: string, commands: EditorCommand[]): void {
    let text = "";
    for (const character of value) {
      if (character === "\n" && this.pastedCarriageReturn) {
        this.pastedCarriageReturn = false;
        continue;
      }
      if (character === "\r") {
        text += "\n";
        this.pastedCarriageReturn = true;
        continue;
      }
      this.pastedCarriageReturn = false;
      if (character === "\n") text += "\n";
      else if (!isControl(character)) text += character;
    }
    if (text.length > 0) commands.push({ type: "paste", text });
  }
}
