import type { PermissionDecision } from "../../agent/permissions";
import type { ConfigLayer, WritableConfigLayer } from "../../config";

/**
 * Pure state machine for the interactive config TUI. No terminal, no I/O: it
 * takes a snapshot of the current config, tracks navigation and overlay state,
 * renders a view model, and — on edits — returns effects the host applies
 * through the config handlers, then reloads a fresh snapshot. The OpenTUI
 * renderer and the headless tests drive the exact same model.
 */

export interface ConfigTuiData {
  /** Named model roles (compiled to the tier ladder by the host on apply). */
  models: {
    plan: string;
    build: string;
    planLayer?: ConfigLayer;
    buildLayer?: ConfigLayer;
    /** Effective variant (reasoning effort) per role — override or profile default. */
    planVariant: string;
    buildVariant: string;
  };
  /** Model ids offered in the picker (from the connected providers). */
  availableModels: string[];
  /** Variants offered per model (what the model accepts). */
  availableVariants: string[];
  providers: { connected: string[]; keySet: boolean };
  trust: {
    uncaged: boolean;
    uncagedLayer?: ConfigLayer;
    rules: Array<{ pattern: string; decision: PermissionDecision; layer?: ConfigLayer }>;
  };
  mcp: Array<{ name: string; transport: string }>;
  /** Display path of each writable layer's file (shown next to the scope). */
  layerPaths: Record<WritableConfigLayer, string>;
}

/** Writable layers the editor can target, in cycle order, with short labels. */
export const SCOPES: readonly WritableConfigLayer[] = ["global", "project", "local"] as const;
export const SCOPE_LABELS: Record<WritableConfigLayer, string> = {
  global: "Global",
  project: "Project",
  local: "ProjectLocal",
};
/** Short provenance tag shown against a value, e.g. "· project". */
const layerNote = (layer: ConfigLayer | undefined): string | undefined =>
  !layer || layer === "default" || layer === "base" ? undefined : layer;

export type ConfigEffect =
  | { kind: "setModel"; role: "plan" | "build"; model: string; variant?: string }
  | { kind: "setRule"; pattern: string; decision: PermissionDecision }
  | { kind: "removeRule"; pattern: string }
  | { kind: "setUncaged"; on: boolean }
  | { kind: "connectProvider" } // host prompts for key, then reloads
  | { kind: "disconnectProvider"; id: string }
  | { kind: "addServer"; name: string; transport: "stdio" | "http"; target: string }
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
  /** Draw a faint separator line above this row (e.g. before the floor). */
  divider?: boolean;
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
  /** Layer edits write to, its human label, and the file it lands in. */
  scope: WritableConfigLayer;
  scopeLabel: string;
  scopePath: string;
}

export interface KeyPress {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  /** The printable character typed, if any (drives text fields in overlays). */
  char?: string;
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
/** The add-server form: you type the real name, transport, and command/URL —
 *  no invented catalog. Fields: 0 = name, 1 = transport, 2 = target. */
const SERVER_FIELDS = 3;
type ServerForm = {
  kind: "server-add";
  field: number;
  name: string;
  transport: "stdio" | "http";
  target: string;
};

type Overlay =
  | { kind: "model"; role: "plan" | "build"; idx: number; variant: string }
  | { kind: "rule-add"; idx: number; decision: PermissionDecision }
  | ServerForm
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
  /** Layer the next edit writes to (the host routes effects here). */
  scope(): WritableConfigLayer;
  reload(data: ConfigTuiData): void;
  toast(text: string): void;
}

export function createConfigTuiModel(initial: ConfigTuiData): ConfigTuiModel {
  let data = initial;
  let section = 0;
  let row = 0;
  let overlay: Overlay = null;
  let toastText: string | undefined;
  let scope: WritableConfigLayer = "global";

  const modelShort = (id: string): string => id.replace(/^gpt-|^claude-/, "");

  const items = (): Item[] => {
    const sec = SECTIONS[section];
    if (sec === "models") return modelItems();
    if (sec === "trust") return trustItems();
    if (sec === "providers") return providerItems();
    return mcpItems();
  };

  const modelItems = (): Item[] => {
    const pick = (role: "plan" | "build"): Item => {
      const variant = role === "plan" ? data.models.planVariant : data.models.buildVariant;
      const layer = layerNote(role === "plan" ? data.models.planLayer : data.models.buildLayer);
      return {
        focusable: true,
        row: {
          label: role === "plan" ? "Plan model" : "Build model",
          value: data.models[role],
          // Note carries the effective variant, plus the source layer if pinned.
          note: layer ? `${variant} · ${layer}` : variant,
        },
        hint: `which model ${role === "plan" ? "investigates and drafts the plan" : "writes the code"} · ⏎ choose model + variant`,
        onEnter: () => {
          overlay = {
            kind: "model",
            role,
            idx: Math.max(0, data.availableModels.indexOf(data.models[role])),
            variant,
          };
          return null;
        },
      };
    };
    return [pick("plan"), pick("build")];
  };

  const trustItems = (): Item[] => {
    const out: Item[] = [];
    out.push({
      focusable: true,
      row: {
        label: "Uncaged",
        value: data.trust.uncaged ? "ON" : "off",
        tone: data.trust.uncaged ? "danger" : "muted",
        note: layerNote(data.trust.uncagedLayer),
      },
      hint: "bypass the ACL — allow every gated tool call · ←→/space toggle",
      onLeft: () => ({ kind: "setUncaged", on: !data.trust.uncaged }),
      onRight: () => ({ kind: "setUncaged", on: !data.trust.uncaged }),
      onEnter: () => ({ kind: "setUncaged", on: !data.trust.uncaged }),
    });
    out.push({
      focusable: false,
      row: { label: "Rules", value: "decision", note: "source", header: true },
    });
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
        row: {
          label: r.pattern,
          value: r.decision,
          tone: decisionTone(r.decision),
          note: layerNote(r.layer),
        },
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
    out.push({
      focusable: false,
      row: { label: "everything else", value: "deny", tone: "muted", divider: true },
    });
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
        overlay = { kind: "server-add", field: 0, name: "", transport: "stdio", target: "" };
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
      const variants = data.availableVariants;
      if (esc) {
        overlay = null;
        return [];
      }
      if (key.name === "up") overlay.idx = Math.max(0, overlay.idx - 1);
      else if (key.name === "down") overlay.idx = Math.min(list.length - 1, overlay.idx + 1);
      else if ((key.name === "left" || key.name === "right") && variants.length) {
        const dir = key.name === "right" ? 1 : -1;
        const at = variants.indexOf(overlay.variant);
        overlay.variant = variants[(at + dir + variants.length) % variants.length];
      } else if (key.name === "return" || key.name === "kpenter") {
        const model = list[overlay.idx];
        const role = overlay.role;
        const variant = overlay.variant;
        overlay = null;
        return model ? [{ kind: "setModel", role, model, variant }] : [];
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
      const form = overlay;
      if (esc) {
        overlay = null;
        return [];
      }
      if (key.name === "up") form.field = Math.max(0, form.field - 1);
      else if (key.name === "down" || key.name === "tab")
        form.field = Math.min(SERVER_FIELDS - 1, form.field + 1);
      else if (
        form.field === 1 &&
        (key.name === "left" || key.name === "right" || key.name === "space")
      )
        form.transport = form.transport === "stdio" ? "http" : "stdio";
      else if (key.name === "return" || key.name === "kpenter") {
        const name = form.name.trim();
        const target = form.target.trim();
        if (!name || !target) return []; // both required; keep the form open
        overlay = null;
        return [{ kind: "addServer", name, transport: form.transport, target }];
      } else if (form.field === 0 || form.field === 2) {
        // Text fields: backspace deletes, space and any printable char append.
        const edit = (s: string): string =>
          key.name === "backspace"
            ? s.slice(0, -1)
            : key.name === "space"
              ? `${s} `
              : key.char
                ? s + key.char
                : s;
        if (form.field === 0) form.name = edit(form.name);
        else form.target = edit(form.target);
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
    if (key.name === "s") {
      // The footer's scope line shows the current scope live, so no toast.
      scope = SCOPES[(SCOPES.indexOf(scope) + 1) % SCOPES.length];
      return [];
    }

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
        title: `${o.role} model · variant ${o.variant}`,
        items: data.availableModels.map((m, i) => ({
          label: modelShort(m),
          note: m,
          cursor: i === o.idx,
        })),
        keys: [
          ["↑↓", "model"],
          ["←→", "variant"],
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
      // A caret marks the focused text field; empty fields show a hint.
      const field = (value: string, focused: boolean, hint: string): string =>
        focused ? `${value}▏` : value || hint;
      ov = {
        title: "add MCP server",
        items: [
          { label: "name", note: field(o.name, o.field === 0, "…"), cursor: o.field === 0 },
          {
            label: "transport",
            note: o.transport === "stdio" ? "‹stdio› http" : "stdio ‹http›",
            cursor: o.field === 1,
          },
          {
            label: o.transport === "http" ? "url" : "command",
            note: field(o.target, o.field === 2, o.transport === "http" ? "https://…" : "npx …"),
            cursor: o.field === 2,
          },
        ],
        keys: [
          ["↑↓", "field"],
          ["←→", "transport"],
          ["type", "edit"],
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
      ["s", "scope"],
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
      scope,
      scopeLabel: SCOPE_LABELS[scope],
      scopePath: data.layerPaths[scope],
    };
  };

  return {
    view,
    handleKey,
    scope: () => scope,
    reload(next) {
      data = next;
      clampRow();
    },
    toast(text) {
      toastText = text;
    },
  };
}
