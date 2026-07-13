/**
 * Minimal, dependency-free template renderer for prompt assembly.
 *
 * Supports three constructs: `{{VAR}}` substitution, `{{#if FLAG}}…{{/if}}`,
 * and `{{#unless FLAG}}…{{/unless}}`. Conditionals nest; we collapse the
 * INNERMOST one first (a body containing no further `{{#`) and repeat until
 * none remain, then substitute vars in a single pass. Every unknown token is
 * a hard error — a malformed prompt should fail loudly at compose time, not
 * ship a literal `{{FOO}}` to the model.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
  flags: Record<string, boolean>,
): string {
  // Matches the innermost conditional: the body `(?!\{\{#)` lookahead forbids a
  // nested opener, so the first match is always a leaf. Backref `\1` pins the
  // close tag to the same kind (if/unless) the block opened with.
  const cond = /\{\{#(if|unless)\s+(\w+)\}\}((?:(?!\{\{#)[\s\S])*?)\{\{\/\1\}\}/;
  let out = template;
  for (let m = cond.exec(out); m; m = cond.exec(out)) {
    const [full, kind, name, body] = m;
    if (!(name in flags))
      throw new Error(`prompt template: unknown flag {{#${kind} ${name}}}`);
    const keep = kind === "if" ? flags[name] : !flags[name];
    out = out.slice(0, m.index) + (keep ? body : "") + out.slice(m.index + full.length);
  }

  out = out.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`prompt template: unknown var {{${name}}}`);
    return vars[name];
  });

  const stray = out.indexOf("{{");
  if (stray !== -1)
    throw new Error(`prompt template: unresolved token "${out.slice(stray, stray + 24)}"`);

  // Removed blocks leave blank-line gaps; normalize runs of 3+ to a single gap.
  return out.replace(/\n{3,}/g, "\n\n");
}
