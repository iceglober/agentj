import { ToolLoopAgent } from "ai";
import { createBashTool } from "bash-tool";
import { loadConfig } from "./lib/config";
import { createModel } from "./lib/llm";
import { getSandbox } from "./lib/sandbox";
import { createSandboxProviderMicrosandbox } from "./lib/sandbox/microsandbox-adapter";
import { createSession } from "./lib/session";
import { createEditTools } from "./lib/tools/edit";
import { createSearchTools } from "./lib/tools/search";

const config = await loadConfig(
  new URL("./agentj.json", import.meta.url).pathname,
);

const model = createModel(config.llm);

await using sandbox = await getSandbox(
  createSandboxProviderMicrosandbox(config.sandbox),
);
await using session = await createSession(sandbox, config.session);

const { tools: bashTools } = await createBashTool({
  sandbox,
  destination: session.path,
});

// editTools last: its mode-specific readFile (line/anchor prefixes) replaces
// bash-tool's plain one, so reads always carry what the edit tool consumes.
const codingAgent = new ToolLoopAgent({
  model,
  temperature: config.llm.temperature,
  tools: {
    ...bashTools,
    ...createSearchTools(sandbox, { root: session.path }),
    ...createEditTools(sandbox, config.tools.edit.mode),
  },
});

const prompt =
  process.argv.slice(2).join(" ") ||
  "Print the OS and python version of the machine you are on.";

const result = await codingAgent.generate({
  prompt,
  onStepFinish: (step) => {
    for (const call of step.toolCalls) {
      console.error(
        `[tool] ${call.toolName} ${JSON.stringify(call.input).slice(0, 200)}`,
      );
    }
  },
});

console.log(result.text);

const sha = await session.commitAll(`agentj: ${prompt.slice(0, 72)}`);
console.error(
  sha
    ? `[session ${session.id}] committed ${sha} on ${session.branch}`
    : `[session ${session.id}] no changes`,
);
