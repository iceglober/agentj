import z from "zod";

/** Terminal UI settings. The renderer defaults to the full-screen OpenTUI
 *  surface; `ansi` opts into the lighter live-region renderer. The
 *  `GLORIOUS_TUI` env var overrides this for a one-off session. */
export const tuiConfigSchema = z
  .object({
    renderer: z.enum(["opentui", "ansi"]).default("opentui"),
  })
  .prefault({});
export type TuiConfig = z.infer<typeof tuiConfigSchema>;
