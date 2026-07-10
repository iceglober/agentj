# Blueprint design skill

A blueprint is the PRESENTABLE version of your plan — a self-contained HTML page you save with
`save_artifact(name, format:"html")`; it opens in the user's browser so they can react to the plan
BEFORE you build. Reach for it when the plan is worth showing (a UI, a layout, a flow, real options to
weigh) rather than telling. Its job is to get the user to DECIDE. Five things make a good one.

## 1. Surface the decisions (this is the point)
- Find the 2–4 open choices that actually change the outcome (e.g. store: in-memory vs shared;
  layout: sidebar vs tabs; auth: sessions vs tokens). Ignore settled or trivial choices.
- Separate the two kinds and treat them differently: choices you can DEFAULT (implementation — stack,
  storage, file layout) get your pick with a one-line why; choices only the USER can answer (what they
  actually want, prototype vs production, what a fuzzy term means to them) get put to them as real
  open questions. NEVER silently pre-decide the second kind — that's the failure this exists to stop.
- For each, think in competing directions, then present the ONE axis that distinguishes them as a
  focused, non-leading question — with YOUR recommendation and a one-line why. One question per
  decision. Don't ask what the user's request already answers.
- Lead with the decisions; keep rationale to a phrase. The user should be able to make every call in
  under a minute.

## 2. High-fidelity, interactive, self-contained mockups
- Make any UI mock look like the REAL product — real copy, real spacing, real components, real
  states — not grey wireframe boxes. Only drop to greyscale wireframe when STRUCTURE (not look) is
  the actual question.
- **Fully interactive, not a static picture.** A UI mockup must actually WORK: tabs and accordions
  switch, buttons and toggles respond, inputs accept text and forms show their validation states,
  navigation moves between views, modals and menus open and close, hover/active states fire. Wire it
  with inline vanilla JS so the user can click through the real flow and judge it — the point of a
  blueprint is that they operate the thing, not squint at a screenshot.
- Self-contained: inline all CSS/JS and embed assets as data URIs. No external fonts/CDN/network — a
  strict sandbox blocks them, so anything remote silently fails.
- Design tokens as CSS custom properties at `:root` (color, type scale, spacing, radius) and reuse
  them; that keeps the mock coherent and easy to restyle.

## 3. Don't default to the AI look — these are YOUR reflexes
You are a Claude model; left unprompted you converge on the same tells. Decide against them.
- **Name the aesthetic in 2–3 words FIRST** (e.g. "warm editorial", "brutalist utility", "clinical
  precision"). "Clean and modern" is the absence of a decision, and it shows.
- **Break the defaults you reach for unprompted:** nested cards (card-in-card), the safe sans
  (Inter / Roboto / system-ui), the purple triplet (`#6366F1` / `#8B5CF6` / `#A855F7`), cyan-on-dark
  "dashboard", and purple→blue gradients. If you typed one without deciding, change it.
- **Type:** pick a face for the mood (geometric sans = precision, humanist serif = warmth, slab =
  authority); monospace only for real code or data.
- **Color:** build from mood → a base hue; avoid pure `#000`/`#fff` (use tinted greys and hue-shifted
  shadows); set hierarchy by weight > size > color, not gradient text.
- **Layout:** vary the presentation — a hero, a list, a table, a callout — instead of the same card
  3–6×; left-align body text; space proportionally (tight within a group, generous between).
- **Detail:** vary shadow depth to signal hierarchy (not one uniform `0.08–0.12` alpha everywhere);
  add blur/glow/animation only when it serves communication; hover only on interactive things.
- **Copy:** specific and verifiable over "streamline / seamless / best-in-class"; `01 / 02 / 03` only
  for a real sequence; skip the "Not X. Y." cadence and the em-dash habit.
- **One signature move.** Give the page a single memorable element and keep everything around it
  calm. Uniform restraint is itself a tell — earn character with 1–3 expressive moments, not five.

## 4. Responsive and operable
- Fluid layout (flex/grid, %/rem, `max-width:100%` on media); it must reflow down to a phone width
  with no horizontal overflow. Wide content (tables, diagrams) scrolls inside its own container.
- Semantic HTML (`header/nav/main/section/button`); touch targets ≥ 44×44px; include a
  `@media (prefers-reduced-motion: reduce)` block. Respect the viewer's light/dark where it's cheap.
- Pick UI patterns by constraint and name the reason in a phrase: Fitts → primary actions large and
  reachable (a bottom bar on mobile); Hick → group or progressively disclose long option lists;
  Miller → break big forms into steps or grouped fields; Jakob → follow the convention users already
  know. Function before decoration — the mock must be operable at a glance (clear affordances,
  feedback, recognition over recall).

## 5. If it shows data
- Choose the encoding that tells the truth (bar for comparison, line for trend, not a pie for many
  slices); label axes; never distort a scale to make a point.

Keep the whole page tight and skimmable. A blueprint that's beautiful but hides the decisions has
failed at its one job.
