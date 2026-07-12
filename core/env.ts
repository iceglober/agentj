import { z } from "zod";

export const env = z
  .object({
    AZURE_FOUNDRY_API_KEY: z.string(),
  })
  .parse(process.env);
