import { defineConfig } from "./lib/config";

export default defineConfig({
  sandbox: {
    bootstrap: [
      "apt-get update && apt-get install -y --no-install-recommends unzip python3",
      "bash -o pipefail -c 'curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s \"bun-v1.3.14\"'",
    ],
  },
  project: {
    setup: ["bun install --frozen-lockfile"],
  },
  agent: {
    llm: {
      providers: {
        azure: {
          resourceName: "kayn-default-foundry-resource",
        },
      },
    },
    instructions: {
      extensions: {
        "architecture-plan": {
          path: ".aj/extensions/plan.md",
          modes: ["plan"],
          roles: ["primary"],
        },
      },
    },
    reflections: {
      prompts: {
        architecture:
          "Ensure you outline how we will leave the code better than we found it. Which existing abstractions will we use? Which will we extend? Which will we remove or create? Leave the code simpler, cleaner, and with a more sound architecture.",
        "checking-your-work":
          "Ensure you outline how we will prove the work is correct. Reproduce the root cause for bugs, name focused and broad checks, inspect the final result, and include browser testing when relevant. State what each check proves and call out any check that cannot run.",
      },
    },
    tools: {
      edit: {
        mode: "batch",
      },
    },
  },
});
