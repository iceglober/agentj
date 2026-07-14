/**
 * Anchored, full-match glob → RegExp. No deps.
 * - `**` matches any depth including empty (crosses `/`)
 * - `*` matches within one segment (no `/`)
 * - `?` matches a single non-`/` char
 * - a trailing `/**` also matches the directory itself (`src/**` ⊇ `src`)
 * - every other char is a literal (regex specials escaped)
 */
export function globMatch(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "/" && pattern[i + 1] === "*" && pattern[i + 2] === "*" && i + 3 === pattern.length) {
      // trailing `/**`: the dir itself or anything beneath it
      re += "(?:/.*)?";
      i += 2;
    } else if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` — any leading path, or none
        } else {
          re += ".*"; // trailing/other `**` — cross segments
        }
      } else {
        re += "[^/]*"; // `*` — within one segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(path);
}
