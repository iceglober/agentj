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
  // Default-deny access control. The schema default is an empty ruleset (deny
  // everything gated); this is the shipped starter policy — usable out of the
  // box, fully overridable per project/machine, and equivalent to the old
  // edit=allow / web=allow / bash=ask / mcp=ask defaults.
  permissions: {
    rules: {
      edit: "allow",
      web: "allow",
      "bash(*)": "ask",
      "bash(git *)": "allow",
      "bash(bun *)": "allow",
      "bash(pnpm *)": "allow",
      "bash(npm *)": "allow",
      "bash(rm -rf *)": "deny",
      "mcp_*": "ask",
    },
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
