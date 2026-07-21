import { type ArmId, benchmarkArms } from "./config";
import { estimatedUsd, type NormalizedUsage } from "./usage";

const MODELS_DEV_URL = "https://models.dev/api.json";

interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
}

interface ModelsDevModel {
  cost?: { input?: number; output?: number; cache_read?: number };
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

export const loadModelsDevPrices = async (): Promise<Record<ArmId, ModelPrice>> => {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) throw new Error(`models.dev pricing request failed: ${response.status}`);
  const catalog = (await response.json()) as Record<string, ModelsDevProvider>;
  return Object.fromEntries(
    benchmarkArms.map((arm) => {
      const cost = catalog[arm.priceProvider]?.models?.[arm.model]?.cost;
      if (cost?.input === undefined || cost.output === undefined) {
        throw new Error(`models.dev has no price for ${arm.priceProvider}/${arm.model}`);
      }
      return [arm.id, { input: cost.input, output: cost.output, cacheRead: cost.cache_read }];
    }),
  ) as Record<ArmId, ModelPrice>;
};

export const estimateMatrixCost = (
  prices: Record<ArmId, ModelPrice>,
  taskCount: number,
  assumedUsage: NormalizedUsage,
): { byArm: Record<ArmId, number>; total: number } => {
  const byArm = Object.fromEntries(
    benchmarkArms.map((arm) => [arm.id, taskCount * estimatedUsd(assumedUsage, prices[arm.id])]),
  ) as Record<ArmId, number>;
  return { byArm, total: Object.values(byArm).reduce((sum, value) => sum + value, 0) };
};
