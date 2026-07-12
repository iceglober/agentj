/** Single-quote a string for POSIX shells. */
export const shq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
