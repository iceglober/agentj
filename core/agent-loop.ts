import { env } from "./env";
import { ToolLoopAgent } from "ai";
import { createAzure } from "@ai-sdk/azure";
import { createBashTool, type Sandbox as BashToolSandbox } from "bash-tool";
import { Sandbox } from "microsandbox";

const azure = createAzure({
  resourceName: "kayn-default-foundry-resource",
  apiKey: env.AZURE_FOUNDRY_API_KEY,
});

await using sb = await Sandbox.builder("worker").image("python").replace().create();

// bash-tool expects { executeCommand, readFile, writeFiles }; microsandbox
// exposes shell()/fs(), so bridge the two.
const bashToolSandbox: BashToolSandbox = {
  async executeCommand(command) {
    const r = await sb.shell(command);
    return { stdout: r.stdout(), stderr: r.stderr(), exitCode: r.code };
  },
  async readFile(path) {
    return sb.fs().readToString(path);
  },
  async writeFiles(files) {
    for (const file of files) {
      const dir = file.path.split("/").slice(0, -1).join("/");
      if (dir) await sb.shell(`mkdir -p '${dir.replaceAll("'", "'\\''")}'`);
      await sb.fs().write(file.path, file.content);
    }
  },
};

const { tools: bashTools } = await createBashTool({
  sandbox: bashToolSandbox,
});

const codingAgent = new ToolLoopAgent({
  model: azure("gpt-5.6-sol"),
  tools: {
    ...bashTools,
  },
});

const prompt = process.argv.slice(2).join(" ") || "Print the OS and python version of the machine you are on.";

const result = await codingAgent.generate({
  prompt,
  onStepFinish: (step) => {
    for (const call of step.toolCalls) {
      console.error(`[tool] ${call.toolName} ${JSON.stringify(call.input).slice(0, 200)}`);
    }
  },
});

console.log(result.text);
