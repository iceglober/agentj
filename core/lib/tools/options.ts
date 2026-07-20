/** Extract the runtime abort signal from opaque tool execution metadata. */
export const requestSignal = (options: unknown): AbortSignal | undefined => {
  if (typeof options !== "object" || options === null) return undefined;
  const signal = (options as { abortSignal?: unknown }).abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
};
