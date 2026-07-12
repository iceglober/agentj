import { ToolLoopAgent } from "ai";
import { createBashTool } from "bash-tool";
import { createModel, type LlmConfig } from "./lib/llm";
import { getSandbox } from "./lib/sandbox";
import { createSandboxProviderMicrosandbox } from "./lib/sandbox/microsandbox-adapter";

const llm: LlmConfig = {
  provider: "azure",
  model: "gpt-5.6-sol",
  resourceName: "kayn-default-foundry-resource",
};

const model = createModel(llm);

await using sandbox = await getSandbox(createSandboxProviderMicrosandbox());

const { tools: bashTools } = await createBashTool({
  sandbox,
  destination: "/workspace",
});

const codingAgent = new ToolLoopAgent({
  model,
  temperature: llm.temperature,
  tools: {
    ...bashTools,
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
