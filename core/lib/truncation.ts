/** Truncate text while reserving room for an exact omitted-character notice. */
export const truncateWithNotice = (value: string, maxLength: number): string => {
  const characters = Array.from(value);
  const limit = Math.max(0, Math.floor(maxLength));
  if (characters.length <= limit) return value;

  let retained = Math.min(characters.length - 1, limit);
  while (true) {
    const omitted = characters.length - retained;
    const notice = `[trunc ${omitted} chars]`;
    const available = limit - notice.length;
    const nextRetained = Math.max(
      0,
      Math.min(characters.length - 1, available > 1 ? available - 1 : 0),
    );
    if (nextRetained === retained) {
      return `${characters.slice(0, retained).join("")}${retained > 0 ? " " : ""}${notice}`;
    }
    retained = nextRetained;
  }
};
