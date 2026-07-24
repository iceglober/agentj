import type { CliRenderer, KeyEvent } from "@opentui/core";
import type { WritableConfigLayer } from "../../config";
import { createOpenTuiStyledText } from "../opentui-styled-text";
import type { UiLine, UiSpan } from "../styles";
import {
  type ConfigEffect,
  type ConfigOverlayColumn,
  type ConfigOverlayView,
  type ConfigTuiData,
  type ConfigView,
  type ConfigViewRow,
  createConfigTuiModel,
} from "./model";

/**
 * Full-screen OpenTUI renderer for the config TUI. Pure rendering + input: it
 * paints the model's view model, feeds decoded key events back to the model,
 * and hands the effects to an injected host (which persists via the config
 * handlers and returns a fresh snapshot). The model holds all the logic; this
 * file only knows OpenTUI.
 */
export interface ConfigTuiScreenOptions {
  /** Load a fresh config snapshot (called at start and after every edit). */
  loadData: () => Promise<ConfigTuiData>;
  /** Persist one effect to the scoped layer; return a short confirmation toast. */
  applyEffect: (effect: ConfigEffect, scope: WritableConfigLayer) => Promise<string | undefined>;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Reuse an existing renderer (in-chat `/config`); otherwise one is created + owned. */
  renderer?: CliRenderer;
}

export async function runConfigTuiScreen(options: ConfigTuiScreenOptions): Promise<void> {
  const opentui = await import("@opentui/core");
  const stdout = options.stdout ?? process.stdout;
  const colorEnabled =
    Boolean((stdout as NodeJS.WriteStream).isTTY) &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb";
  const styled = createOpenTuiStyledText(opentui, colorEnabled);

  const ownsRenderer = options.renderer === undefined;
  const renderer =
    options.renderer ??
    (await opentui.createCliRenderer({
      stdin: options.stdin ?? process.stdin,
      stdout: stdout as NodeJS.WriteStream,
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
      useMouse: false,
      consoleMode: "disabled",
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
    }));

  const model = createConfigTuiModel(await options.loadData());

  // ---- UI tree: title · rule · tabs · body (rows) · footer (hint + keys) ----
  // No panes or borders — hierarchy comes from spacing, weight, and aligned
  // columns, so the screen reads like a quiet document, not a boxed dashboard.
  const root = new opentui.BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const titleText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  const ruleText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  const gapText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  const bodyText = new opentui.TextRenderable(renderer, {
    content: "",
    width: "100%",
    flexGrow: 1,
    minHeight: 0,
  });
  const hintText = new opentui.TextRenderable(renderer, {
    content: "",
    wrapMode: "word",
    width: "100%",
  });
  // Footer: the write scope, then the target file below it, then the key legend.
  const scopeText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  const pathText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  const keysText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });

  const overlayBox = new opentui.BoxRenderable(renderer, {
    position: "absolute",
    zIndex: 100,
    border: true,
    borderStyle: "double",
    top: 2,
    left: 8,
    minWidth: 64,
    padding: 1,
    flexDirection: "column",
    ...(colorEnabled ? { backgroundColor: opentui.RGBA.fromHex("#0d1117") } : {}),
  });
  const overlayText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  overlayBox.add(overlayText);
  overlayBox.visible = false;

  root.add(titleText);
  root.add(ruleText);
  root.add(gapText);
  root.add(bodyText);
  root.add(hintText);
  root.add(scopeText);
  root.add(pathText);
  root.add(keysText);
  root.add(overlayBox);
  renderer.root.add(root);

  const contentWidth = (): number => Math.max(30, renderer.terminalWidth - 2);
  // Value and provenance sit in fixed columns so the eye scans straight down.
  const VALUE_COL = 30;
  const NOTE_COL = 42;
  const barWidth = (): number => Math.min(contentWidth(), 62);
  const hr = (): UiLine => [{ text: "─".repeat(contentWidth()), tone: "muted" }];

  // ---- view → styled lines ----
  // Keep the meaningful tail (filename, parent dirs) and drop the head with a
  // leading ellipsis, so a deep path never wraps its line.
  const truncateStart = (s: string, max: number): string =>
    s.length <= max ? s : `…${s.slice(s.length - max + 1)}`;

  const pad = (col: number, at: number): string => " ".repeat(Math.max(1, at - col));

  const rowLine = (r: ConfigViewRow): UiLine => {
    if (r.header) {
      // Group header: uppercase, faint, with column captions over value/note.
      const label = `  ${r.label.toUpperCase()}`;
      const spans: UiSpan[] = [{ text: label, tone: "muted", bold: true }];
      let col = label.length;
      if (r.value) {
        spans.push({ text: pad(col, VALUE_COL), tone: "muted" });
        spans.push({ text: r.value, tone: "muted" });
        col = Math.max(col + 1, VALUE_COL) + r.value.length;
      }
      if (r.note) {
        spans.push({ text: pad(col, NOTE_COL), tone: "muted" });
        spans.push({ text: r.note, tone: "muted" });
      }
      return spans;
    }
    const bg: UiSpan["background"] = r.cursor ? "muted" : undefined;
    const arrow = r.cursor ? "▸ " : "  ";
    const spans: UiSpan[] = [
      {
        text: `${arrow}${r.label}`,
        background: bg,
        bold: r.cursor || r.action,
        tone: r.action ? r.tone : undefined,
      },
    ];
    let col = arrow.length + r.label.length;
    if (r.value) {
      const gap = pad(col, VALUE_COL);
      spans.push({ text: gap, background: bg });
      col += gap.length;
      spans.push({ text: r.value, tone: r.tone, background: bg });
      col += r.value.length;
    }
    if (r.note) {
      const gap = pad(col, NOTE_COL);
      spans.push({ text: gap, background: bg });
      col += gap.length;
      spans.push({ text: r.note, tone: "muted", background: bg });
      col += r.note.length;
    }
    // Extend the highlight into a full-width bar under the cursor.
    if (r.cursor && col < barWidth())
      spans.push({ text: " ".repeat(barWidth() - col), background: bg });
    return spans;
  };

  const bodyLines = (v: ConfigView): UiLine[] => {
    const lines: UiLine[] = [];
    for (const r of v.rows) {
      if (r.header) lines.push([{ text: "" }]); // breathe before a group
      if (r.divider) lines.push(hr());
      lines.push(rowLine(r));
    }
    return lines;
  };

  // Miller-column layout: header row · search row · aligned item rows.
  const COL_WIDTHS = [17, 26, 14];
  const spanW = (spans: UiSpan[]): number => spans.reduce((n, s) => n + s.text.length, 0);
  const padCell = (
    spans: UiSpan[],
    width: number,
    bg?: UiSpan["background"],
    last = false,
  ): UiSpan[] => {
    const gap = Math.max(0, width - spanW(spans));
    return [
      ...spans,
      ...(gap ? [{ text: " ".repeat(gap), background: bg } as UiSpan] : []),
      ...(last ? [] : [{ text: "  " } as UiSpan]),
    ];
  };
  const columnLines = (cols: ConfigOverlayColumn[]): UiLine[] => {
    const w = (i: number): number => COL_WIDTHS[i] ?? 16;
    const last = (i: number): boolean => i === cols.length - 1;
    const rowCount = Math.max(1, ...cols.map((c) => c.items.length));
    const lines: UiLine[] = [];
    lines.push(
      cols.flatMap((c, i) =>
        padCell(
          [{ text: c.title, tone: c.active ? "accent" : "muted", bold: c.active }],
          w(i),
          undefined,
          last(i),
        ),
      ),
    );
    lines.push(
      cols.flatMap((c, i) => {
        const s: UiSpan[] =
          c.active && c.search !== undefined && c.search.length > 0
            ? [
                { text: `/${c.search}`, tone: "accent" },
                { text: "▏", tone: "accent" },
              ]
            : [{ text: "" }];
        return padCell(s, w(i), undefined, last(i));
      }),
    );
    for (let r = 0; r < rowCount; r += 1) {
      lines.push(
        cols.flatMap((c, i) => {
          const it = c.items[r];
          if (!it) return padCell([{ text: "" }], w(i), undefined, last(i));
          const bg: UiSpan["background"] = it.cursor && c.active ? "muted" : undefined;
          const tone: UiSpan["tone"] =
            it.cursor && !c.active ? "accent" : it.muted ? "muted" : undefined;
          return padCell(
            [
              {
                text: `${it.cursor ? "▸ " : "  "}${it.label}`,
                background: bg,
                tone,
                bold: it.cursor,
              },
            ],
            w(i),
            bg,
            last(i),
          );
        }),
      );
    }
    return lines;
  };

  const overlayLines = (o: ConfigOverlayView): UiLine[] => {
    if (o.columns) {
      return [
        [{ text: o.title, bold: true, tone: "accent" }],
        [{ text: "" }],
        ...columnLines(o.columns),
        [{ text: "" }],
        keyLine(o.keys),
      ];
    }
    const lines: UiLine[] = [[{ text: o.title, bold: true, tone: "accent" }]];
    if (o.control) {
      // The ←→-cycled value sits by the title, its value highlighted as the
      // anchor for the ←→ control.
      lines.push([
        { text: `${o.control.label}  `, tone: "muted" },
        { text: "←→ ", tone: "muted" },
        { text: o.control.value, tone: "warning", bold: true },
      ]);
    }
    lines.push([{ text: "" }]);
    for (const it of o.items) {
      const bg: UiSpan["background"] = it.cursor ? "muted" : undefined;
      const spans: UiSpan[] = [
        { text: `${it.cursor ? "▸ " : "  "}${it.label}`, background: bg, bold: it.cursor },
      ];
      if (it.note) spans.push({ text: `   ${it.note}`, tone: "muted", background: bg });
      lines.push(spans);
    }
    lines.push([{ text: "" }]);
    lines.push(keyLine(o.keys));
    return lines;
  };

  const keyLine = (keys: ReadonlyArray<readonly [string, string]>): UiLine =>
    keys.flatMap((pair, i): UiSpan[] => [
      ...(i > 0 ? [{ text: "  " } as UiSpan] : []),
      { text: pair[0], bold: true },
      { text: ` ${pair[1]}`, tone: "muted" },
    ]);

  const render = (): void => {
    const v = model.view();
    const section = v.sections.find((s) => s.active)?.label ?? "";
    // Header: one line, `glorious / <section>`.
    titleText.content = styled.toStyledText([[{ text: ` glorious / ${section}`, bold: true }]]);
    ruleText.content = styled.toStyledText([hr()]);
    bodyText.content = styled.toStyledText(bodyLines(v));
    hintText.content = styled.toStyledText([
      v.toast
        ? [{ text: ` ${v.toast}`, tone: "success" } as UiSpan]
        : v.hint
          ? [{ text: ` ${v.hint}`, tone: "muted" } as UiSpan]
          : [{ text: "" } as UiSpan],
    ]);
    // Footer: scope (green), the target file below it (truncated from the start
    // so a deep path never wraps), then the key legend.
    scopeText.content = styled.toStyledText([
      [
        { text: " scope: ", tone: "success" },
        { text: v.scopeLabel, tone: "success", bold: true },
      ],
    ]);
    pathText.content = styled.toStyledText([
      [{ text: ` ${truncateStart(v.scopePath, Math.max(12, contentWidth() - 2))}`, tone: "muted" }],
    ]);
    keysText.content = styled.toStyledText([[{ text: " " } as UiSpan, ...keyLine(v.keys)]]);
    if (v.overlay) {
      overlayText.content = styled.toStyledText(overlayLines(v.overlay));
      overlayBox.visible = true;
    } else {
      overlayBox.visible = false;
    }
    if (started && !stopped) renderer.requestRender();
  };

  // ---- input + lifecycle ----
  let started = false;
  let stopped = false;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const mapKey = (
    e: KeyEvent,
  ): { name: string; ctrl?: boolean; shift?: boolean; char?: string } => {
    const raw = e.name ?? "";
    // A single printable byte (letters, digits, symbols, space) drives text
    // fields; control keys carry only a name.
    const seq = e.sequence ?? "";
    const char = !e.ctrl && !e.meta && seq.length === 1 && seq >= " " ? seq : undefined;
    return {
      name: raw === " " || raw === "space" ? "space" : raw,
      ctrl: e.ctrl,
      shift: e.shift,
      char,
    };
  };

  let handling = false;
  const onKeypress = (e: KeyEvent): void => {
    if (handling) return;
    handling = true;
    void (async () => {
      try {
        const effects = model.handleKey(mapKey(e));
        for (const effect of effects) {
          if (effect.kind === "quit") {
            finish();
            return;
          }
          const toast = await options.applyEffect(effect, model.scope());
          if (toast) model.toast(toast);
        }
        if (effects.length) model.reload(await options.loadData());
        render();
      } finally {
        handling = false;
      }
    })();
  };

  const onResize = (): void => render();

  const onFatalSignal = (signal: NodeJS.Signals): void => {
    process.removeListener("SIGTERM", onFatalSignal);
    process.removeListener("SIGHUP", onFatalSignal);
    if (!stopped) {
      stopped = true;
      try {
        if (ownsRenderer) renderer.destroy();
      } catch {
        /* terminal restore is best-effort on a fatal signal */
      }
    }
    process.kill(process.pid, signal);
  };

  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    renderer.keyInput.off("keypress", onKeypress);
    renderer.off("resize", onResize);
    process.removeListener("SIGTERM", onFatalSignal);
    process.removeListener("SIGHUP", onFatalSignal);
    if (ownsRenderer) {
      renderer.destroy();
    } else {
      renderer.root.remove(root);
      root.destroy();
      renderer.requestRender();
    }
    resolveDone?.();
  };

  started = true;
  renderer.keyInput.on("keypress", onKeypress);
  renderer.on("resize", onResize);
  process.on("SIGTERM", onFatalSignal);
  process.on("SIGHUP", onFatalSignal);
  if (ownsRenderer) renderer.start();
  render();

  await done;
}
