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
          path: ".glorious/extensions/plan.md",
          modes: ["plan"],
          roles: ["primary"],
        },
      },
    },
    tools: {
      edit: {
        mode: "batch",
      },
    },
  },
});
