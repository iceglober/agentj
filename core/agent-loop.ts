import { env } from "./env";
import { ToolLoopAgent } from "ai";
import { createAzure } from "@ai-sdk/azure";
import { createBashTool } from "bash-tool";
import { getSandbox } from "./lib/sandbox";
import { createSandboxProviderMicrosandbox } from "./lib/sandbox/microsandbox-adapter";

const azure = createAzure({
  resourceName: "kayn-default-foundry-resource",
  apiKey: env.AZURE_FOUNDRY_API_KEY,
});

await using sandbox = await getSandbox(createSandboxProviderMicrosandbox());

const { tools: bashTools } = await createBashTool({
  sandbox,
});

const codingAgent = new ToolLoopAgent({
  model: azure("gpt-5.6-sol"),
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
