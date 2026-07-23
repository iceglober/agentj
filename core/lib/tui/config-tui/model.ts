import type { PermissionDecision } from "../../agent/permissions";

/**
 * Pure state machine for the interactive config TUI. No terminal, no I/O: it
 * takes a snapshot of the current config, tracks navigation and overlay state,
 * renders a view model, and — on edits — returns effects the host applies
 * through the config handlers, then reloads a fresh snapshot. The OpenTUI
 * renderer and the headless tests drive the exact same model.
 */

export interface ConfigTuiData {
  /** Named model roles (compiled to the tier ladder by the host on apply). */
  models: { plan: string; build: string };
  /** Model ids offered in the picker (from the connected providers). */
  availableModels: string[];
  providers: { connected: string[]; keySet: boolean };
  trust: { uncaged: boolean; rules: Array<{ pattern: string; decision: PermissionDecision }> };
  mcp: Array<{ name: string; transport: string }>;
}

export type ConfigEffect =
  | { kind: "setModel"; role: "plan" | "build"; model: string }
  | { kind: "setRule"; pattern: string; decision: PermissionDecision }
  | { kind: "removeRule"; pattern: string }
  | { kind: "setUncaged"; on: boolean }
  | { kind: "connectProvider" } // host prompts for key, then reloads
  | { kind: "disconnectProvider"; id: string }
  | { kind: "addServer"; name: string; transport: "stdio" | "http" }
  | { kind: "removeServer"; name: string }
  | { kind: "reloadMcp" }
  | { kind: "quit" };

export type UiTone = "accent" | "muted" | "success" | "warning" | "danger";

export interface ConfigViewRow {
  label: string;
  value?: string;
  tone?: UiTone;
  /** Small right-aligned annotation (scope, transport, key status). */
  note?: string;
  cursor: boolean;
  /** Non-focusable header/blank rows are skipped by the cursor. */
  header?: boolean;
  action?: boolean;
}

export interface ConfigOverlayView {
  title: string;
  items: Array<{ label: string; note?: string; cursor: boolean }>;
  input?: { prompt: string; value: string; masked?: boolean };
  keys: Array<[string, string]>;
}

export interface ConfigView {
  title: string;
  sections: Array<{ label: string; active: boolean }>;
  rows: ConfigViewRow[];
  hint?: string;
  keys: Array<[string, string]>;
  overlay?: ConfigOverlayView;
  toast?: string;
}

export interface KeyPress {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
}

const SECTIONS = ["models", "trust", "providers", "mcp"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABELS: Record<Section, string> = {
  models: "Models",
  trust: "Trust",
  providers: "Providers",
  mcp: "MCP",
};

const DECISIONS: PermissionDecision[] = ["allow", "ask", "deny"];
const decisionTone = (d: PermissionDecision): UiTone =>
  d === "allow" ? "success" : d === "deny" ? "danger" : "warning";

/** Idiomatic patterns offered when adding a rule (no invented DSL). */
export const RULE_SUGGESTIONS = [
  "bash(*)",
  "bash(git *)",
  "bash(pnpm *)",
  "bash(npm *)",
  "edit",
  "web",
  "mcp_*",
];
const MCP_SERVER_SUGGESTIONS: Array<[string, "stdio" | "http"]> = [
  ["github", "stdio"],
  ["linear", "http"],
  ["sentry", "stdio"],
  ["postgres", "stdio"],
];

type Overlay =
  | { kind: "model"; role: "plan" | "build"; idx: number }
  | { kind: "rule-add"; idx: number; decision: PermissionDecision }
  | { kind: "server-add"; idx: number }
  | null;

/** One focusable/renderable row plus what editing it does. */
interface Item {
  row: Omit<ConfigViewRow, "cursor">;
  focusable: boolean;
  onLeft?: () => ConfigEffect | null;
  onRight?: () => ConfigEffect | null;
  onEnter?: () => ConfigEffect | null;
  onRemove?: () => ConfigEffect | null;
  hint?: string;
}

export interface ConfigTuiModel {
  view(): ConfigView;
  /** Handle a key. Returns effects for the host to apply (then call reload). */
  handleKey(key: KeyPress): ConfigEffect[];
  reload(data: ConfigTuiData): void;
  toast(text: string): void;
}

export function createConfigTuiModel(initial: ConfigTuiData): ConfigTuiModel {
  let data = initial;
  let section = 0;
  let row = 0;
  let overlay: Overlay = null;
  let toastText: string | undefined;

  const modelShort = (id: string): string => id.replace(/^gpt-|^claude-/, "");

  const items = (): Item[] => {
    const sec = SECTIONS[section];
    if (sec === "models") return modelItems();
    if (sec === "trust") return trustItems();
    if (sec === "providers") return providerItems();
    return mcpItems();
  };

  const modelItems = (): Item[] => {
    const pick = (role: "plan" | "build"): Item => ({
      focusable: true,
      row: { label: role === "plan" ? "Plan model" : "Build model", value: data.models[role] },
      hint: `which model ${role === "plan" ? "investigates and drafts the plan" : "writes the code"} · ←→ cycle · ⏎ pick`,
      onLeft: () => cycleModel(role, -1),
      onRight: () => cycleModel(role, 1),
      onEnter: () => {
        overlay = {
          kind: "model",
          role,
          idx: Math.max(0, data.availableModels.indexOf(data.models[role])),
        };
        return null;
      },
    });
    return [pick("plan"), pick("build")];
  };

  const cycleModel = (role: "plan" | "build", dir: number): ConfigEffect | null => {
    const list = data.availableModels;
    if (!list.length) return null;
    const i = (list.indexOf(data.models[role]) + dir + list.length) % list.length;
    return { kind: "setModel", role, model: list[i] };
  };

  const trustItems = (): Item[] => {
    const out: Item[] = [];
    out.push({
      focusable: true,
      row: {
        label: "Uncaged",
        value: data.trust.uncaged ? "ON" : "off",
        tone: data.trust.uncaged ? "danger" : "muted",
      },
      hint: "bypass the ACL — allow every gated tool call · ←→/space toggle",
      onLeft: () => ({ kind: "setUncaged", on: !data.trust.uncaged }),
      onRight: () => ({ kind: "setUncaged", on: !data.trust.uncaged }),
      onEnter: () => ({ kind: "setUncaged", on: !data.trust.uncaged }),
    });
    out.push({ focusable: false, row: { label: "access control · default-deny", header: true } });
    if (data.trust.uncaged) {
      out.push({
        focusable: false,
        row: { label: "⚠ open season — rules bypassed", header: true, tone: "danger" },
      });
      return out;
    }
    for (const r of data.trust.rules) {
      out.push({
        focusable: true,
        row: { label: r.pattern, value: r.decision, tone: decisionTone(r.decision) },
        hint: "pattern → decision · deny beats allow · ←→ decision · x remove",
        onLeft: () => cycleRule(r.pattern, -1),
        onRight: () => cycleRule(r.pattern, 1),
        onRemove: () => ({ kind: "removeRule", pattern: r.pattern }),
      });
    }
    out.push({
      focusable: true,
      row: { label: "+ add rule", action: true, tone: "accent" },
      hint: "add an allow rule from an idiomatic pattern · ⏎ open",
      onEnter: () => {
        overlay = { kind: "rule-add", idx: 0, decision: "allow" };
        return null;
      },
    });
    out.push({ focusable: false, row: { label: "everything else", value: "deny", tone: "muted" } });
    return out;
  };

  const cycleRule = (pattern: string, dir: number): ConfigEffect | null => {
    const cur = data.trust.rules.find((r) => r.pattern === pattern);
    if (!cur) return null;
    const next = DECISIONS[(DECISIONS.indexOf(cur.decision) + dir + 3) % 3];
    return { kind: "setRule", pattern, decision: next };
  };

  const providerItems = (): Item[] => {
    const out: Item[] = [];
    for (const id of data.providers.connected) {
      out.push({
        focusable: true,
        row: { label: id, value: data.providers.keySet ? "key ✓" : "no key", tone: "muted" },
        hint: "a connected model provider · ⏎ re-enter key · x disconnect",
        onEnter: () => ({ kind: "connectProvider" }),
        onRemove: () => ({ kind: "disconnectProvider", id }),
      });
    }
    out.push({
      focusable: true,
      row: { label: "+ connect provider", action: true, tone: "accent" },
      hint: "connect an @ai-sdk provider · ⏎ open",
      onEnter: () => ({ kind: "connectProvider" }),
    });
    return out;
  };

  const mcpItems = (): Item[] => {
    const out: Item[] = [];
    for (const s of data.mcp) {
      out.push({
        focusable: true,
        row: { label: s.name, value: s.transport, tone: "muted", note: "● connected" },
        hint: "a Model Context Protocol server · x remove (hot-reloads)",
        onRemove: () => ({ kind: "removeServer", name: s.name }),
      });
    }
    out.push({
      focusable: true,
      row: { label: "+ add server", action: true, tone: "accent" },
      hint: "add a server — idempotent, hot-reloads instantly · ⏎ open",
      onEnter: () => {
        overlay = { kind: "server-add", idx: 0 };
        return null;
      },
    });
    return out;
  };

  const focusableIndexes = (list: Item[]): number[] =>
    list.map((it, i) => (it.focusable ? i : -1)).filter((i) => i >= 0);

  const clampRow = (): void => {
    const focus = focusableIndexes(items());
    if (!focus.length) {
      row = 0;
      return;
    }
    if (!focus.includes(row)) row = focus[0];
  };

  const moveCursor = (dir: number): void => {
    const focus = focusableIndexes(items());
    if (!focus.length) return;
    const pos = focus.indexOf(row);
    const next = pos < 0 ? 0 : Math.max(0, Math.min(focus.length - 1, pos + dir));
    row = focus[next];
  };

  const switchSection = (dir: number): void => {
    section = (section + dir + SECTIONS.length) % SECTIONS.length;
    row = 0;
    overlay = null;
    clampRow();
  };

  const overlayKey = (key: KeyPress): ConfigEffect[] => {
    if (!overlay) return [];
    const esc = key.name === "escape";
    if (overlay.kind === "model") {
      const list = data.availableModels;
      if (esc) {
        overlay = null;
        return [];
      }
      if (key.name === "up") overlay.idx = Math.max(0, overlay.idx - 1);
      else if (key.name === "down") overlay.idx = Math.min(list.length - 1, overlay.idx + 1);
      else if (key.name === "return" || key.name === "kpenter") {
        const model = list[overlay.idx];
        const role = overlay.role;
        overlay = null;
        return model ? [{ kind: "setModel", role, model }] : [];
      }
      return [];
    }
    if (overlay.kind === "rule-add") {
      if (esc) {
        overlay = null;
        return [];
      }
      if (key.name === "up") overlay.idx = Math.max(0, overlay.idx - 1);
      else if (key.name === "down")
        overlay.idx = Math.min(RULE_SUGGESTIONS.length - 1, overlay.idx + 1);
      else if (key.name === "left" || key.name === "right") {
        const dir = key.name === "right" ? 1 : -1;
        overlay.decision = DECISIONS[(DECISIONS.indexOf(overlay.decision) + dir + 3) % 3];
      } else if (key.name === "return" || key.name === "kpenter") {
        const pattern = RULE_SUGGESTIONS[overlay.idx];
        const decision = overlay.decision;
        overlay = null;
        return [{ kind: "setRule", pattern, decision }];
      }
      return [];
    }
    if (overlay.kind === "server-add") {
      if (esc) {
        overlay = null;
        return [];
      }
      if (key.name === "up") overlay.idx = Math.max(0, overlay.idx - 1);
      else if (key.name === "down")
        overlay.idx = Math.min(MCP_SERVER_SUGGESTIONS.length - 1, overlay.idx + 1);
      else if (key.name === "return" || key.name === "kpenter") {
        const [name, transport] = MCP_SERVER_SUGGESTIONS[overlay.idx];
        overlay = null;
        return [{ kind: "addServer", name, transport }];
      }
      return [];
    }
    return [];
  };

  const handleKey = (key: KeyPress): ConfigEffect[] => {
    toastText = undefined;
    if (overlay) return overlayKey(key);

    if ((key.name === "c" && key.ctrl) || key.name === "q") return [{ kind: "quit" }];
    if (key.name === "tab") {
      switchSection(key.shift ? -1 : 1);
      return [];
    }
    if (key.name === "up" || (key.name === "p" && key.ctrl)) {
      moveCursor(-1);
      return [];
    }
    if (key.name === "down" || (key.name === "n" && key.ctrl)) {
      moveCursor(1);
      return [];
    }
    if (key.name === "r" && SECTIONS[section] === "mcp") return [{ kind: "reloadMcp" }];

    const it = items()[row];
    if (!it) return [];
    if (key.name === "left") return effect(it.onLeft?.());
    if (key.name === "right") return effect(it.onRight?.());
    if (key.name === "return" || key.name === "kpenter" || key.name === "space") {
      // onEnter (even returning null — it opened an overlay) takes precedence;
      // rows without one fall back to a right-cycle so ⏎ still edits.
      if (it.onEnter) return effect(it.onEnter());
      return effect(it.onRight?.());
    }
    if (key.name === "x") return effect(it.onRemove?.());
    return [];
  };

  const effect = (e: ConfigEffect | null | undefined): ConfigEffect[] => (e ? [e] : []);

  const view = (): ConfigView => {
    const list = items();
    clampRow();
    const rows: ConfigViewRow[] = list.map((it, i) => ({
      ...it.row,
      cursor: i === row && !overlay,
    }));
    const cur = list[row];
    const sec = SECTIONS[section];

    let ov: ConfigOverlayView | undefined;
    if (overlay && overlay.kind === "model") {
      const o = overlay;
      ov = {
        title: `${o.role} model`,
        items: data.availableModels.map((m, i) => ({
          label: modelShort(m),
          note: m,
          cursor: i === o.idx,
        })),
        keys: [
          ["↑↓", "move"],
          ["⏎", "select"],
          ["esc", "cancel"],
        ],
      };
    } else if (overlay && overlay.kind === "rule-add") {
      const o = overlay;
      ov = {
        title: `add rule · ${o.decision}`,
        items: RULE_SUGGESTIONS.map((p, i) => ({ label: p, cursor: i === o.idx })),
        keys: [
          ["↑↓", "move"],
          ["←→", "decision"],
          ["⏎", "add"],
          ["esc", "cancel"],
        ],
      };
    } else if (overlay && overlay.kind === "server-add") {
      const o = overlay;
      ov = {
        title: "add MCP server",
        items: MCP_SERVER_SUGGESTIONS.map(([n, t], i) => ({
          label: n,
          note: t,
          cursor: i === o.idx,
        })),
        keys: [
          ["↑↓", "move"],
          ["⏎", "add + reload"],
          ["esc", "cancel"],
        ],
      };
    }

    const keys: Array<[string, string]> = [
      ["↑↓", "move"],
      ["tab", "section"],
      ["←→", "change"],
      ["⏎", "edit"],
      ["x", "remove"],
      ...(sec === "mcp" ? ([["r", "reload"]] as Array<[string, string]>) : []),
      ["q", "quit"],
    ];

    return {
      title: `glorious config · ${SECTION_LABELS[sec]}`,
      sections: SECTIONS.map((s, i) => ({ label: SECTION_LABELS[s], active: i === section })),
      rows,
      hint: overlay ? undefined : cur?.hint,
      keys,
      overlay: ov,
      toast: toastText,
    };
  };

  return {
    view,
    handleKey,
    reload(next) {
      data = next;
      clampRow();
    },
    toast(text) {
      toastText = text;
    },
  };
}
