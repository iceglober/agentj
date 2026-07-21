import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { benchmarkArms, pilotTaskIds } from "./config";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};

const benchRoot = resolve(flag("root") ?? "/tmp/agentj-external-bench");
const selectedTasks = pilotTaskIds.filter(
  (id) => !flag("task") || flag("task")?.split(",").includes(id),
);
const selectedArms = benchmarkArms.filter(
  ({ id }) => !flag("arm") || flag("arm")?.split(",").includes(id),
);
const outputDir = join(benchRoot, "predictions");
await mkdir(outputDir, { recursive: true });

for (const arm of selectedArms) {
  const predictions = [];
  for (const instanceId of selectedTasks) {
    const patchPath = join(benchRoot, "runs", instanceId, arm.id, "patch.diff");
    if (!(await Bun.file(patchPath).exists())) continue;
    predictions.push({
      instance_id: instanceId,
      model_name_or_path: `${arm.id}/${arm.model}`,
      model_patch: await readFile(patchPath, "utf8"),
    });
  }
  if (predictions.length === 0) continue;
  const outputPath = join(outputDir, `${arm.id}.json`);
  await Bun.write(outputPath, `${JSON.stringify(predictions, null, 2)}\n`);
  console.log(`${arm.id}: ${predictions.length} prediction(s) -> ${outputPath}`);
}
