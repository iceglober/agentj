import type { CliRenderer, KeyEvent } from "@opentui/core";
import { createOpenTuiStyledText } from "../opentui-styled-text";
import type { UiLine, UiSpan } from "../styles";
import {
  type ConfigEffect,
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
  /** Persist one effect; return a short confirmation toast. */
  applyEffect: (effect: ConfigEffect) => Promise<string | undefined>;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Reuse an existing renderer (in-chat `/config`); otherwise one is created + owned. */
  renderer?: CliRenderer;
}

const LEFT_WIDTH = 18;

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

  // ---- UI tree ----
  const root = new opentui.BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const content = new opentui.BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 1,
    width: "100%",
    minHeight: 0,
  });
  const leftBox = new opentui.BoxRenderable(renderer, {
    border: true,
    borderStyle: "single",
    width: LEFT_WIDTH,
    flexShrink: 0,
    title: "config",
    flexDirection: "column",
  });
  const leftText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  leftBox.add(leftText);
  const rightBox = new opentui.BoxRenderable(renderer, {
    border: true,
    borderStyle: "single",
    flexGrow: 1,
    flexDirection: "column",
    minHeight: 0,
  });
  const rightText = new opentui.TextRenderable(renderer, {
    content: "",
    wrapMode: "word",
    width: "100%",
  });
  const hintText = new opentui.TextRenderable(renderer, {
    content: "",
    wrapMode: "word",
    width: "100%",
  });
  rightBox.add(rightText);
  rightBox.add(hintText);
  content.add(leftBox);
  content.add(rightBox);

  const barBg = colorEnabled ? { backgroundColor: opentui.RGBA.fromHex("#383f47") } : {};
  const topBar = new opentui.BoxRenderable(renderer, { flexShrink: 0, width: "100%", ...barBg });
  const titleText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  topBar.add(titleText);
  const keybar = new opentui.BoxRenderable(renderer, { flexShrink: 0, width: "100%", ...barBg });
  const keysText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  keybar.add(keysText);

  const overlayBox = new opentui.BoxRenderable(renderer, {
    position: "absolute",
    zIndex: 100,
    border: true,
    borderStyle: "double",
    top: 2,
    left: 8,
    minWidth: 40,
    padding: 1,
    flexDirection: "column",
    ...(colorEnabled ? { backgroundColor: opentui.RGBA.fromHex("#0d1117") } : {}),
  });
  const overlayText = new opentui.TextRenderable(renderer, { content: "", width: "100%" });
  overlayBox.add(overlayText);
  overlayBox.visible = false;

  root.add(topBar);
  root.add(content);
  root.add(keybar);
  root.add(overlayBox);
  renderer.root.add(root);

  const rightWidth = (): number => Math.max(24, renderer.terminalWidth - LEFT_WIDTH - 5);

  // ---- view → styled lines ----
  const sectionLines = (v: ConfigView): UiLine[] =>
    v.sections.map(
      (s): UiLine =>
        s.active
          ? [{ text: `▌${s.label}`, bold: true, background: "muted" }]
          : [{ text: ` ${s.label}`, tone: "muted" }],
    );

  const rowLine = (r: ConfigViewRow, width: number): UiLine => {
    if (r.header) return [{ text: `  ${r.label}`, tone: r.tone ?? "muted", bold: true }];
    const bg: UiSpan["background"] = r.cursor ? "muted" : undefined;
    const label = `${r.cursor ? "▸ " : "  "}${r.label}`;
    const value = r.value ?? "";
    const note = r.note ? `  ${r.note}` : "";
    const pad = Math.max(1, width - label.length - value.length - note.length);
    const line: UiSpan[] = [
      {
        text: label,
        background: bg,
        bold: r.cursor || r.action,
        tone: r.action ? r.tone : undefined,
      },
      { text: " ".repeat(pad), background: bg },
    ];
    if (value) line.push({ text: value, tone: r.tone, background: bg, bold: r.cursor });
    if (note) line.push({ text: note, tone: "muted", background: bg });
    return line;
  };

  const overlayLines = (o: ConfigOverlayView): UiLine[] => {
    const lines: UiLine[] = [[{ text: o.title, bold: true, tone: "accent" }], [{ text: "" }]];
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
    const width = rightWidth();
    titleText.content = styled.toStyledText([[{ text: ` ▍ ${v.title}`, bold: true }]]);
    leftText.content = styled.toStyledText(sectionLines(v));
    rightText.content = styled.toStyledText(v.rows.map((r) => rowLine(r, width)));
    hintText.content = styled.toStyledText([
      v.toast
        ? [{ text: `  ${v.toast}`, tone: "success" } as UiSpan]
        : v.hint
          ? [{ text: `  ${v.hint}`, tone: "muted" } as UiSpan]
          : [{ text: "" } as UiSpan],
    ]);
    keysText.content = styled.toStyledText([keyLine(v.keys)]);
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

  const mapKey = (e: KeyEvent): { name: string; ctrl?: boolean; shift?: boolean } => {
    const raw = e.name ?? "";
    return { name: raw === " " || raw === "space" ? "space" : raw, ctrl: e.ctrl, shift: e.shift };
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
          const toast = await options.applyEffect(effect);
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
