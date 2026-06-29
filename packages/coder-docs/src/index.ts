// coder-docs — a dependency-free docs site organized around coder's core concepts/abstractions.
// `bun run packages/coder-docs/src/index.ts` (or `bun run dev`) serves it on CODER_DOCS_PORT
// (default 4180). Concepts live in SECTIONS; a live Build-status section reads TODOS.md.
import { join } from "node:path";

interface Section {
  id: string;
  title: string;
  /** Trusted HTML (authored here, not user input). */
  html: string;
}

// Each section is one concept: what it is, why it exists, how it works.
const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "Overview",
    html: `<p><strong>coder</strong> is a coding agent built on one bet: <em>prefer computation to inference, and treat
      context as a budget</em>. Long context degrades every model's accuracy (not just its cost), so coder keeps what's
      in front of the model short and relevant, computes facts deterministically wherever it can, and spends tokens only
      where a model genuinely adds value.</p>
      <p>The sections below are the concepts that fall out of that bet. Read them as the tool's mental model, not a manual.</p>`,
  },
  {
    id: "operations",
    title: "Operations",
    html: `<p>The core primitive. An <strong>operation</strong> is plain code: input → structured output, <em>no model
      call</em>. Where a fact can be computed — the state of a repo, where a symbol is defined, which package manager a
      project uses — coder computes it instead of asking the model. Faster, cheaper, and exact.</p>
      <p>Each operation declares an <strong>effect</strong> (read / verify / write) and one or more <strong>surfaces</strong>:
      a slash command, a tool the model can call, a filter applied to a noisy tool's output, or a direct route from intent.
      "Compute over inference" is not a slogan here — it's this primitive, used everywhere it fits.</p>`,
  },
  {
    id: "tools",
    title: "Tools",
    html: `<p>The agent's hands — read and edit files, search, run commands. Every tool declares an <strong>effect</strong>:</p>
      <ul>
        <li><strong>read</strong> — <code>read_file</code>, <code>grep</code>, <code>glob</code>, <code>list_dir</code>, <code>git_state</code>, <code>find_def</code></li>
        <li><strong>verify</strong> — <code>script</code> (runs the project's real checks via its toolchain; no source edits)</li>
        <li><strong>write</strong> — <code>write_file</code>, <code>edit_file</code>, <code>bash</code> (arbitrary execution)</li>
      </ul>
      <p>A subagent's capability is just a <em>filtered view of the tools by effect</em>. That's how the read-only
      investigator is defined — read + verify, no write — without a separate permission mode. Output is truncated inside
      each tool so noisy results never bloat context.</p>`,
  },
  {
    id: "prompts",
    title: "Prompts",
    html: `<p>Behavior is shaped <em>structurally</em>, not by hoping. The <strong>charter</strong> sets the working rules
      and the <strong>verdict standard</strong>: lead with the answer, point to the <code>file:line</code>, tag each claim
      <em>checked / reasoned / guess</em>, and say what you did <em>not</em> check. An <strong>output contract</strong>
      enforces calculated brevity.</p>
      <p>Roles swap the charter for a focused mandate — the <strong>investigator</strong> prompt is "find the root cause,
      stop when confirmed, don't edit." A prompt is a lever pulled deliberately, and its effect (e.g. verbosity) is measured,
      not assumed.</p>`,
  },
  {
    id: "subagents",
    title: "Subagents",
    html: `<p>coder decides per task — no user command. A cheap <strong>triage</strong> routes the task: <em>investigate</em>
      vs <em>direct</em>. An investigation spawns a read-only <strong>investigator</strong> subagent in its <em>own
      isolated context</em>: it finds the root cause and returns a compact <strong>verdict</strong> (cause with
      <code>file:line</code>, evidence, the fix), never its 40-step transcript. An <strong>implementer</strong> then acts
      on that verdict.</p>
      <p>The orchestrator keeps only the distilled verdict — aggressive context protection — while passing a compact
      <strong>working memory</strong> forward so references like "that PR" survive across turns.</p>`,
  },
  {
    id: "context",
    title: "Context management",
    html: `<p>Context is a budget, held for <em>accuracy</em> as much as cost. The levers:</p>
      <ul>
        <li><strong>Compaction</strong> — long sessions summarize older turns into a compact note, keeping recent ones verbatim.</li>
        <li><strong>Caching</strong> — the stable prefix is measured and priced at the cheaper <code>cache_read</code> rate.</li>
        <li><strong>Data in tools, not prompts</strong> — e.g. project commands live in the <code>script</code> tool, so the prompt is a pointer, not a dump.</li>
        <li><strong>Subagent isolation</strong> — exploration transcripts are discarded; only the verdict survives.</li>
      </ul>
      <p>The goal is always the fewest, most relevant tokens in front of the model.</p>`,
  },
  {
    id: "permissions",
    title: "Permissions",
    html: `<p>A policy decides, per tool call: <strong>allow / ask / deny</strong> — keyed to the tool's effect. Postures
      (the user's stance):</p>
      <ul>
        <li><code>auto</code> (default) — edits and commands run without asking.</li>
        <li><code>ask</code> — prompts <code>[y/N]</code> before writes/commands.</li>
        <li><code>auto-edit</code> — auto edits, ask before commands.</li>
        <li><code>plan</code> — read-only; writes/commands denied.</li>
      </ul>
      <p>Reads are never gated. Posture is the <em>user's</em> policy on the acting agent — separate from a subagent's
      role (which is a toolset).</p>`,
  },
  {
    id: "models",
    title: "Models",
    html: `<p>Tiers (<code>cheap/fast/mid/deep</code>) map to concrete models; <code>/model &lt;id&gt;</code> switches live
      (persisted to <code>~/.coder/config.json</code>). Pricing comes from the public <a href="https://models.dev">models.dev</a>
      catalog — cached, accurate per real model, and cache-aware (honors the &gt;200k-context tier).</p>
      <p>The agentic loop runs <strong>non-streaming</strong> (the AI SDK's <code>ToolLoopAgent</code>): Gemini-3 is a
      thinking model whose <em>thought signatures</em> carry reasoning between steps, and the streaming path mangles them
      on multi-step tool use. Non-streaming round-trips them correctly.</p>`,
  },
  {
    id: "facts",
    title: "Project facts",
    html: `<p>coder <em>computes</em> how to run a repo's tasks rather than guessing (the npm-vs-pnpm class of error). It
      detects <strong>toolchains</strong> (js, python; pluggable — adding a language is one detector) from markers like the
      <code>packageManager</code> field, lockfiles, and <code>[tool.uv]</code>, and maps tasks to exact commands.</p>
      <p>The <code>script(task, path)</code> tool runs a named task using the toolchain that <em>governs that path</em> —
      the model names a task, never a binary. Results persist to <code>.coder/facts.json</code> (<code>{computed,
      overrides}</code>; human overrides win). Remote CI is never assumed — local checks are universal; anything
      stack-specific is a declared command, not a baked-in vendor.</p>`,
  },
  {
    id: "verdicts",
    title: "Verdicts",
    html: `<p>coder does <em>not</em> grade its own correctness — no machine check tells you a task was done <em>right</em>.
      The only correctness signal is the human's, <strong>borrowed</strong> via a one-key sign-off at the resolution event
      (<code>accepted</code> / <code>rejected</code> / <code>abandoned</code> / <code>unknown</code>), never computed.</p>
      <p>Machine checks (tests, typecheck) are <em>gates</em>, not scores. So coder's actual job is to make that "yes" cheap
      to give: a conclusion written to be confirmed at a glance — which is exactly the verdict standard the charter enforces.</p>`,
  },
  {
    id: "receipts",
    title: "Receipts",
    html: `<p>Every task writes one <strong>receipt</strong> to an append-only ledger: <strong>effort</strong> (turns, tool
      calls, files read/written — all computed), <strong>cost</strong> + cached tokens, the model used, and the borrowed
      <strong>verdict</strong>. <code>/stats</code> rolls them up — verdict mix, accepted-rate, average effort.</p>
      <p>The ledger is the source of truth for the status view and for distillation. North star: <em>time-to-confirmed-resolution</em>,
      trending down.</p>`,
  },
  {
    id: "distillation",
    title: "Distillation",
    html: `<p>The self-improvement loop <em>(roadmap)</em>. The <strong>Distiller</strong> mines receipts for work the agent
      keeps repeating and proposes a deterministic <strong>operation</strong> to replace it — turning inference coder paid
      for once into computation it gets free forever. Proposals are replay-validated against recorded examples and earn
      trust from evidence, not assertion.</p>
      <p>It closes the loop: the same "compute over inference" thesis, applied by coder to its own history.</p>`,
  },
  {
    id: "run",
    title: "Running it",
    html: `<pre><code>export GOOGLE_VERTEX_PROJECT=&lt;gcp-project&gt;
bun bin/coder                 # interactive chat (in-process, default)
bun bin/coder --once "&lt;task&gt;" # one task, then exit
bun bin/coder --serve         # host an HTTP/SSE server
bun bin/coder --connect &lt;url&gt; # attach to a running server</code></pre>
      <p>Chat commands: <code>/model</code> · <code>/models</code> · <code>/facts</code> · <code>/stats</code> ·
      <code>/y</code> <code>/n</code> <code>/skip</code> (sign-off) · <code>/exit</code> (Ctrl-C = abandon the last result).
      Packages: <code>coder-core</code> (types + event log), <code>coder-server</code> (engine), <code>coder-tui</code>
      (the command), <code>coder-docs</code> (this page).</p>`,
  },
  {
    id: "palette",
    title: "Palette",
    html: `<p>The site's full Pantone Color of the Year collection:</p>
      <div style="display:flex; gap:8px;">
        <div style="width:32px; height:32px; border-radius:4px; background:var(--pantone-2024-peach-fuzz)" title="Peach Fuzz"></div>
        <div style="width:32px; height:32px; border-radius:4px; background:var(--pantone-2023-viva-magenta)" title="Viva Magenta"></div>
        <div style="width:32px; height:32px; border-radius:4px; background:var(--pantone-2022-very-peri)" title="Very Peri"></div>
        <div style="width:32px; height:32px; border-radius:4px; background:var(--pantone-2021-ultimate-gray)" title="Ultimate Gray"></div>
        <div style="width:32px; height:32px; border-radius:4px; background:var(--pantone-2021-illuminating)" title="Illuminating"></div>
        <div style="width:32px; height:32px; border-radius:4px; background:var(--pantone-2020-classic-blue)" title="Classic Blue"></div>
      </div>`,
  },
];

interface TodoItem {
  status: "done" | "partial" | "todo";
  text: string;
}
interface Area {
  title: string;
  items: TodoItem[];
}

const STATUS_OF: Record<string, TodoItem["status"]> = { "✅": "done", "🟡": "partial", "⬜": "todo" };
const BADGE: Record<TodoItem["status"], string> = { done: "✅", partial: "🟡", todo: "⬜" };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Light markdown for trusted TODOS text: escape, then `code` and **bold**. */
const lightMd = (s: string): string => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
const clip = (s: string, n = 220): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** Parse TODOS_1.md (done) + TODOS_2.md (remaining) into per-area items — the granular build state. */
async function readStatus(): Promise<{ total: Record<TodoItem["status"], number>; areas: Area[] } | null> {
  try {
    let md = "";
    for (const f of ["TODOS_1.md", "TODOS_2.md"]) {
      try {
        md += `${await Bun.file(join(import.meta.dir, "../../../", f)).text()}\n`;
      } catch {
        // a file may be missing if run standalone — skip it
      }
    }
    if (!md.trim()) return null;
    let cur: Area = { title: "General", items: [] };
    const all = [cur];
    for (const line of md.split("\n")) {
      const h = line.match(/^#{2,3}\s+(.+)/);
      if (h) {
        cur = { title: h[1].replace(/[`*]/g, "").trim(), items: [] };
        all.push(cur);
        continue;
      }
      const m = line.match(/^\s*-\s*(✅|🟡|⬜)\s+(.+)/);
      if (m) cur.items.push({ status: STATUS_OF[m[1]], text: m[2].trim() });
    }
    const areas = all.filter((a) => a.items.length);
    const count = (s: TodoItem["status"]) => areas.reduce((n, a) => n + a.items.filter((i) => i.status === s).length, 0);
    return { total: { done: count("done"), partial: count("partial"), todo: count("todo") }, areas };
  } catch {
    return null; // TODOS.md not reachable (package run standalone) — skip the section
  }
}

function renderStatus(status: Awaited<ReturnType<typeof readStatus>>): string {
  if (!status) return "";
  const { total, areas } = status;
  const body = areas
    .map((a) => {
      const items = a.items
        .map((i) => `<li class="t-${i.status}"><span class="badge">${BADGE[i.status]}</span> ${lightMd(clip(i.text))}</li>`)
        .join("");
      return `<h3>${esc(a.title)}</h3><ul class="todos">${items}</ul>`;
    })
    .join("");
  return `<section id="status"><h2>Build status</h2>
    <p>Live from <code>TODOS_1.md</code> + <code>TODOS_2.md</code>: <strong>✅ ${total.done} done</strong> · 🟡 ${total.partial} in progress · ⬜ ${total.todo} planned.</p>
    ${body}</section>`;
}

function renderPage(statusSection: string): string {
  const navItems = SECTIONS.map((s) => `<a href="#${s.id}">${s.title}</a>`);
  if (statusSection) navItems.push(`<a href="#status">Build status</a>`);
  const nav = navItems.join("");
  const body = SECTIONS.map((s) => `<section id="${s.id}"><h2>${s.title}</h2>${s.html}</section>`).join("\n") + statusSection;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coder — concepts</title>
<style>
  :root {
    /* Pantone Color of the Year Collection */
    --pantone-2024-peach-fuzz: #FFBE98;
    --pantone-2023-viva-magenta: #BE3455;
    --pantone-2022-very-peri: #6667AB;
    --pantone-2021-ultimate-gray: #939597;
    --pantone-2021-illuminating: #F5DF4D;
    --pantone-2020-classic-blue: #0F4C81;
  }
  :root { color-scheme: light dark; --fg:#1a1a1a; --muted:var(--pantone-2021-ultimate-gray); --accent:var(--pantone-2020-classic-blue); --bg:#fff; --code:#f4f4f5; --line:#e5e5e5; }
  @media (prefers-color-scheme: dark){ :root{ --fg:#e8e8e8; --muted:var(--pantone-2021-ultimate-gray); --accent:var(--pantone-2024-peach-fuzz); --bg:#121212; --code:#1e1e1e; --line:#2a2a2a; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .layout { display:flex; max-width:1100px; margin:0 auto; align-items:flex-start; padding:32px 24px; gap:48px; }
  .sidebar { position:sticky; top:32px; width:220px; flex-shrink:0; display:flex; flex-direction:column; gap:4px; max-height:calc(100vh - 64px); overflow-y:auto; }
  .sidebar header h1 { font-size:2rem; margin:0; line-height:1.2; }
  .sidebar header p { color:var(--muted); margin:.4rem 0 1.5rem; font-size:.9rem; line-height:1.4; }
  .sidebar a { color:var(--fg); text-decoration:none; font-size:.95rem; padding:6px 10px; border-radius:6px; margin:0; }
  .sidebar a:hover { background:var(--code); color:var(--accent); }
  .content { flex:1; max-width:760px; padding-bottom:96px; }
  @media (max-width: 768px) {
    .layout { flex-direction:column; gap:24px; padding:24px 16px; }
    .sidebar { position:static; width:100%; max-height:none; overflow-y:visible; border-bottom:1px solid var(--line); padding-bottom:16px; }
    .sidebar a { display:inline-block; margin:0; }
    .sidebar { flex-direction:row; flex-wrap:wrap; align-items:center; gap:8px 12px; }
    .sidebar header { width:100%; margin-bottom:8px; }
    .sidebar header p { margin-bottom:.5rem; }
  }
  section { margin:0 0 3.5rem; scroll-margin-top:32px; } h2 { font-size:1.35rem; margin:0 0 .8rem; }
  p, ul { margin:.6rem 0; } li { margin:.25rem 0; }
  code { background:var(--code); padding:.1em .35em; border-radius:4px; font-size:.88em;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background:var(--code); padding:14px 16px; border-radius:8px; overflow:auto; }
  pre code { background:none; padding:0; }
  a { color:var(--accent); }
  h3 { font-size:1.02rem; margin:1.5rem 0 .35rem; }
  ul.todos { list-style:none; padding-left:0; margin:.2rem 0 .8rem; }
  ul.todos li { padding:.14rem 0 .14rem 1.7rem; text-indent:-1.7rem; font-size:.92rem; }
  .badge { display:inline-block; width:1.3rem; }
  .t-todo { color:var(--muted); }
  footer { margin-top:4rem; padding-top:1.5rem; border-top:1px solid var(--line); color:var(--muted); font-size:.85rem; }
</style></head>
<body><div class="layout">
  <aside class="sidebar">
    <header><h1>coder</h1><p>a coding agent that computes over inferring — the concepts</p></header>
    ${nav}
  </aside>
  <main class="content">
    ${body}
    <footer>Generated by <code>coder-docs</code> — the Build status above is read live from <code>TODOS_1.md</code> + <code>TODOS_2.md</code> on each request.</footer>
  </main>
</div></body></html>`;
}

const port = Number(process.env.CODER_DOCS_PORT) || 4180;

Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return Response.json({ ok: true });
    const page = renderPage(renderStatus(await readStatus()));
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.error(`coder-docs on http://localhost:${port}`);
