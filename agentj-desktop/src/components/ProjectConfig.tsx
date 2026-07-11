// The Settings modal's "Project" pane: purpose-built controls per config aspect, no raw files.
//  - Hooks: a card per lifecycle hook (status, script, Save / Run now / Remove)
//  - Agent settings: real form fields for the repo's .aj/aj.json budget keys
//  - MCP servers: structured server cards (name, transport, command/url, env) for .mcp.json
// Everything round-trips through the backend's allowlisted, JSON-validated file API; unknown
// JSON keys (provider blocks, extra server options) are preserved on save.
import { useCallback, useEffect, useState } from "react";
import { configFiles, hooksCatalog, runHookNow, writeConfigFile, writeHook } from "../session";
import type { HookInfo } from "../types";

type Note = { ok: boolean; text: string } | null;

const noteEl = (n: Note) =>
  n ? <span className={"cfg-status" + (n.ok ? " ok" : " err")}>{n.text}</span> : null;

// ── hooks ────────────────────────────────────────────────────────────────────

const HOOK_TEMPLATES: Record<string, string> = {
  worktree_new: `#!/usr/bin/env bash
# Provision this worktree — runs automatically ONCE per worktree
# (and again whenever this script changes), before the agent acts.
set -euo pipefail

corepack enable
pnpm install
`,
  session_start: `#!/usr/bin/env bash
# Runs EVERY time a session opens in this worktree — start services, refresh state.
set -euo pipefail
`,
};

function HookCard({ sessionId, hook, onChanged }: { sessionId: string; hook: HookInfo; onChanged: () => void }) {
  const [open, setOpen] = useState(hook.exists);
  const [draft, setDraft] = useState(hook.exists ? hook.content : (HOOK_TEMPLATES[hook.kind] ?? "#!/usr/bin/env bash\n"));
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<Note>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      setNote({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      await writeHook(sessionId, hook.kind, draft);
      setDirty(false);
      onChanged();
      return {
        ok: true,
        text: hook.kind === "worktree_new" ? "saved — re-runs automatically next session" : "saved",
      };
    });

  const remove = () =>
    act(async () => {
      await writeHook(sessionId, hook.kind, "");
      setDraft(HOOK_TEMPLATES[hook.kind] ?? "#!/usr/bin/env bash\n");
      setDirty(false);
      setOpen(false);
      onChanged();
      return { ok: true, text: "removed" };
    });

  const run = () =>
    act(async () => {
      const r = await runHookNow(sessionId, hook.kind);
      return r
        ? { ok: r.ok, text: r.summary }
        : { ok: true, text: "nothing to do — already ran for this version (edit to re-run)" };
    });

  return (
    <div className="cfg-card">
      <div className="cfg-card-head">
        <span className="cfg-card-title">{hook.kind}</span>
        <span className={"cfg-badge" + (hook.exists ? " on" : "")}>
          {hook.exists ? "Installed" : "Not installed"}
        </span>
        <span className="cfg-card-actions">
          {!hook.exists && !open && (
            <button className="btn3d" onClick={() => setOpen(true)}>
              Add
            </button>
          )}
          {hook.exists && !dirty && (
            <button className="btn3d" onClick={run} disabled={busy}>
              Run now
            </button>
          )}
          {hook.exists && (
            <button className="btn3d" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
        </span>
      </div>
      <span className="cfg-hint">{hook.description}</span>
      {open && (
        <>
          <textarea
            className="cfg-text cfg-script"
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
              setNote(null);
            }}
            aria-label={`${hook.kind} script`}
          />
          <div className="cfg-actions">
            <button
              className="btn3d primary"
              onClick={save}
              disabled={busy || (hook.exists && !dirty)}
            >
              {hook.exists ? "Save" : "Create"}
            </button>
            {!hook.exists && (
              <button className="btn3d" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
            )}
            {noteEl(note)}
          </div>
        </>
      )}
      {!open && noteEl(note)}
    </div>
  );
}

// ── agent settings (.aj/aj.json) ─────────────────────────────────────────────

// The repo-level keys with a dedicated control. Everything else in aj.json (provider blocks,
// company) is preserved untouched on save.
interface AjForm {
  max_steps: string;
  max_idle_nudges: string;
  job_idle_wait_s: string;
}

const AJ_FIELDS: { key: keyof AjForm; label: string; hint: string; placeholder: string; numeric: boolean }[] = [
  {
    key: "max_steps",
    label: "Max steps per turn",
    hint: "Model round-trips before the step gate pauses a turn.",
    placeholder: "40",
    numeric: true,
  },
  {
    key: "max_idle_nudges",
    label: "Max idle waits",
    hint: "How often a turn may idle-wait for a background job before ending.",
    placeholder: "6",
    numeric: true,
  },
  {
    key: "job_idle_wait_s",
    label: "Idle wait (seconds)",
    hint: "Ceiling on a single wait for a background job.",
    placeholder: "120",
    numeric: true,
  },
];

function AgentSettings({ sessionId, raw, onChanged }: { sessionId: string; raw: string; onChanged: () => void }) {
  const parse = useCallback((): AjForm => {
    let v: Record<string, unknown> = {};
    try {
      v = JSON.parse(raw || "{}");
    } catch {}
    const s = (k: string) => (v[k] === undefined || v[k] === null ? "" : String(v[k]));
    return { max_steps: s("max_steps"), max_idle_nudges: s("max_idle_nudges"), job_idle_wait_s: s("job_idle_wait_s") };
  }, [raw]);

  const [form, setForm] = useState<AjForm>(parse);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    setForm(parse());
    setDirty(false);
  }, [parse]);

  const save = async () => {
    let root: Record<string, unknown> = {};
    try {
      root = JSON.parse(raw || "{}");
    } catch {}
    for (const f of AJ_FIELDS) {
      const value = form[f.key].trim();
      if (value === "") delete root[f.key];
      else if (f.numeric) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          setNote({ ok: false, text: `${f.label} must be a positive whole number` });
          return;
        }
        root[f.key] = n;
      } else root[f.key] = value;
    }
    try {
      const empty = Object.keys(root).length === 0;
      await writeConfigFile(sessionId, ".aj/aj.json", empty ? "" : `${JSON.stringify(root, null, 2)}\n`);
      setNote({ ok: true, text: "saved" });
      setDirty(false);
      onChanged();
    } catch (e) {
      setNote({ ok: false, text: String(e) });
    }
  };

  return (
    <div className="cfg-card">
      {AJ_FIELDS.map((f) => (
        <label className="cfg-row" key={f.key}>
          <span className="cfg-row-text">
            <span className="cfg-label">{f.label}</span>
            <span className="cfg-hint">{f.hint}</span>
          </span>
          <input
            className="cfg-input"
            type="text"
            inputMode={f.numeric ? "numeric" : undefined}
            value={form[f.key]}
            placeholder={f.placeholder}
            onChange={(e) => {
              setForm((p) => ({ ...p, [f.key]: e.target.value }));
              setDirty(true);
              setNote(null);
            }}
          />
        </label>
      ))}
      <div className="cfg-actions">
        <button className="btn3d primary" onClick={save} disabled={!dirty}>
          Save
        </button>
        {noteEl(note)}
      </div>
    </div>
  );
}

// ── MCP servers (.mcp.json) ──────────────────────────────────────────────────

interface ServerForm {
  name: string;
  kind: "stdio" | "remote";
  command: string; // command + args as one line (split on whitespace when saving)
  url: string;
  env: string; // KEY=VALUE per line
  disabled: boolean;
  extra: Record<string, unknown>; // unknown keys, preserved verbatim
}

export function serversFrom(raw: string): ServerForm[] {
  let root: Record<string, unknown> = {};
  try {
    root = JSON.parse(raw || "{}");
  } catch {}
  const servers = (root.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(servers).map(([name, s]) => {
    const { command, args, url, env, disabled, ...extra } = s;
    return {
      name,
      kind: typeof command === "string" ? "stdio" : "remote",
      command: [command, ...((args as string[]) ?? [])].filter(Boolean).join(" "),
      url: typeof url === "string" ? url : "",
      env: Object.entries((env as Record<string, string>) ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      disabled: disabled === true,
      extra,
    };
  });
}

export function serversToJson(list: ServerForm[]): string {
  const out: Record<string, unknown> = {};
  for (const s of list) {
    if (!s.name.trim()) continue;
    const entry: Record<string, unknown> = { ...s.extra };
    if (s.kind === "stdio") {
      const parts = s.command.trim().split(/\s+/).filter(Boolean);
      entry.command = parts[0] ?? "";
      if (parts.length > 1) entry.args = parts.slice(1);
    } else {
      entry.url = s.url.trim();
    }
    const env: Record<string, string> = {};
    for (const line of s.env.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf("=");
      if (eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1);
    }
    if (Object.keys(env).length) entry.env = env;
    if (s.disabled) entry.disabled = true;
    out[s.name.trim()] = entry;
  }
  if (Object.keys(out).length === 0) return "";
  return `${JSON.stringify({ mcpServers: out }, null, 2)}\n`;
}

function McpServers({ sessionId, raw, onChanged }: { sessionId: string; raw: string; onChanged: () => void }) {
  const [list, setList] = useState<ServerForm[]>(() => serversFrom(raw));
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    setList(serversFrom(raw));
    setDirty(false);
  }, [raw]);

  const patch = (i: number, p: Partial<ServerForm>) => {
    setList((l) => l.map((s, j) => (j === i ? { ...s, ...p } : s)));
    setDirty(true);
    setNote(null);
  };

  const save = async () => {
    const names = list.filter((s) => s.name.trim()).map((s) => s.name.trim());
    if (new Set(names).size !== names.length) {
      setNote({ ok: false, text: "server names must be unique" });
      return;
    }
    try {
      await writeConfigFile(sessionId, ".mcp.json", serversToJson(list));
      setNote({ ok: true, text: "saved — servers reconnect on the next session" });
      setDirty(false);
      onChanged();
    } catch (e) {
      setNote({ ok: false, text: String(e) });
    }
  };

  return (
    <div className="cfg-cards">
      {list.length === 0 && <div className="cfg-hint">No MCP servers configured.</div>}
      {list.map((s, i) => (
        <div className="cfg-card" key={i}>
          <div className="cfg-card-head">
            <input
              className="cfg-input cfg-name"
              type="text"
              value={s.name}
              placeholder="server name"
              onChange={(e) => patch(i, { name: e.target.value })}
              aria-label="Server name"
            />
            <select
              className="cfg-input cfg-kind"
              value={s.kind}
              onChange={(e) => patch(i, { kind: e.target.value as ServerForm["kind"] })}
              aria-label="Transport"
            >
              <option value="stdio">stdio (local command)</option>
              <option value="remote">remote (http/sse url)</option>
            </select>
            <span className="cfg-card-actions">
              <label className="cfg-check">
                <input
                  type="checkbox"
                  checked={s.disabled}
                  onChange={(e) => patch(i, { disabled: e.target.checked })}
                />
                disabled
              </label>
              <button
                className="btn3d"
                onClick={() => {
                  setList((l) => l.filter((_, j) => j !== i));
                  setDirty(true);
                }}
              >
                Remove
              </button>
            </span>
          </div>
          {s.kind === "stdio" ? (
            <label className="cfg-row">
              <span className="cfg-row-text">
                <span className="cfg-label">Command</span>
                <span className="cfg-hint">Executable and arguments, one line.</span>
              </span>
              <input
                className="cfg-input"
                type="text"
                value={s.command}
                placeholder="bun fake-mcp/tickets.mjs"
                onChange={(e) => patch(i, { command: e.target.value })}
              />
            </label>
          ) : (
            <label className="cfg-row">
              <span className="cfg-row-text">
                <span className="cfg-label">URL</span>
                <span className="cfg-hint">Streamable-http or SSE endpoint.</span>
              </span>
              <input
                className="cfg-input"
                type="text"
                value={s.url}
                placeholder="https://example.com/mcp"
                onChange={(e) => patch(i, { url: e.target.value })}
              />
            </label>
          )}
          <label className="cfg-row">
            <span className="cfg-row-text">
              <span className="cfg-label">Environment</span>
              <span className="cfg-hint">KEY=VALUE per line; ${"{VAR}"} expands from your shell.</span>
            </span>
            <textarea
              className="cfg-text cfg-env"
              spellCheck={false}
              value={s.env}
              onChange={(e) => patch(i, { env: e.target.value })}
              aria-label="Environment variables"
            />
          </label>
        </div>
      ))}
      <div className="cfg-actions">
        <button
          className="btn3d"
          onClick={() => {
            setList((l) => [
              ...l,
              { name: "", kind: "stdio", command: "", url: "", env: "", disabled: false, extra: {} },
            ]);
            setDirty(true);
          }}
        >
          Add server
        </button>
        <button className="btn3d primary" onClick={save} disabled={!dirty}>
          Save
        </button>
        {noteEl(note)}
      </div>
    </div>
  );
}

// ── the pane ─────────────────────────────────────────────────────────────────

export function ProjectPane({
  sessionId,
  section,
}: {
  sessionId: string | null;
  section: "hooks" | "agent" | "mcp";
}) {
  const [hooks, setHooks] = useState<HookInfo[] | null>(null);
  const [ajRaw, setAjRaw] = useState<string | null>(null);
  const [mcpRaw, setMcpRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [h, files] = await Promise.all([hooksCatalog(sessionId), configFiles(sessionId)]);
      setHooks(h);
      setAjRaw(files.find((f) => f.path === ".aj/aj.json")?.content ?? "");
      setMcpRaw(files.find((f) => f.path === ".mcp.json")?.content ?? "");
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!sessionId) return <div className="set-empty">No active session.</div>;
  if (error) return <div className="set-empty">{error}</div>;
  if (!hooks || ajRaw === null || mcpRaw === null) return <div className="set-empty">Loading…</div>;

  if (section === "hooks") {
    return (
      <div className="cfg-cards">
        {hooks.map((h) => (
          <HookCard key={h.kind + String(h.exists)} sessionId={sessionId} hook={h} onChanged={load} />
        ))}
      </div>
    );
  }
  if (section === "agent") {
    return <AgentSettings sessionId={sessionId} raw={ajRaw} onChanged={load} />;
  }
  return <McpServers sessionId={sessionId} raw={mcpRaw} onChanged={load} />;
}
