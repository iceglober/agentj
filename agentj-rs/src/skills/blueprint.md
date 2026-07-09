# Blueprint design skill

A blueprint is a self-contained HTML page you save with `save_artifact(name, format:"html")`; it opens
in the user's browser so you can align on a design BEFORE building. Its job is to get the user to
DECIDE. Four things make a good one.

## 1. Surface the decisions (this is the point)
- Find the 2–4 open choices that actually change the outcome (e.g. store: in-memory vs shared;
  layout: sidebar vs tabs; auth: sessions vs tokens). Ignore settled or trivial choices.
- For each, think in competing directions, then present the ONE axis that distinguishes them as a
  focused, non-leading question — with YOUR recommendation and a one-line why. One question per
  decision. Don't ask what the user's request already answers.
- Lead with the decisions; keep rationale to a phrase. The user should be able to make every call in
  under a minute.

## 2. High-fidelity mockups
- Make any UI mock look like the REAL product — real copy, real spacing, real components, real
  states — not grey wireframe boxes. Only drop to greyscale wireframe when STRUCTURE (not look) is
  the actual question.
- Self-contained: inline all CSS/JS and embed assets as data URIs. No external fonts/CDN/network — a
  strict sandbox blocks them, so anything remote silently fails.
- Design tokens as CSS custom properties at `:root` (color, type scale, spacing, radius) and reuse
  them; that keeps the mock coherent and easy to restyle.

## 3. Responsive and operable
- Fluid layout (flex/grid, %/rem, `max-width:100%` on media); it must reflow down to a phone width
  with no horizontal overflow. Wide content (tables, diagrams) scrolls inside its own container.
- Semantic HTML (`header/nav/main/section/button`); touch targets ≥ 44×44px; include a
  `@media (prefers-reduced-motion: reduce)` block. Respect the viewer's light/dark where it's cheap.
- Pick UI patterns by constraint and name the reason in a phrase: Fitts → primary actions large and
  reachable (a bottom bar on mobile); Hick → group or progressively disclose long option lists;
  Miller → break big forms into steps or grouped fields; Jakob → follow the convention users already
  know. Function before decoration — the mock must be operable at a glance (clear affordances,
  feedback, recognition over recall).

## 4. If it shows data
- Choose the encoding that tells the truth (bar for comparison, line for trend, not a pie for many
  slices); label axes; never distort a scale to make a point.

Keep the whole page tight and skimmable. A blueprint that's beautiful but hides the decisions has
failed at its one job.
