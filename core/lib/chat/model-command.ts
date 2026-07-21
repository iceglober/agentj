import type { ChatCommandContext, ModelTarget } from "./command-context";

export const modelTargets = {
  primary: "Primary agent",
  subagents: "Subagents and background jobs",
} as const;

export const runModelCommand = async (context: ChatCommandContext, args: string): Promise<void> => {
  if (!context.models) {
    context.emit({ type: "notice", text: "Model selection is unavailable in this session." });
    return;
  }
  if (!context.guided) {
    context.emit({ type: "notice", text: "Guided input is unavailable in this session." });
    return;
  }
  const guided = context.guided;

  let target = args.trim();
  if (!target) {
    const selected = await guided.askInput({
      label: "Configure which agents?",
      choices: Object.keys(modelTargets),
      validate: (value) => (value in modelTargets ? null : "Choose primary or subagents."),
    });
    if (selected === null) return;
    target = selected;
  }
  if (!(target in modelTargets)) {
    context.emit({ type: "notice", text: "Usage: /model [primary|subagents]" });
    return;
  }
  const modelTarget = target as ModelTarget;
  const current = context.models.current();
  const selected = modelTarget === "primary" ? current.primary : current.subagents;
  const providerChoices = [
    ...(selected ? [selected.provider] : []),
    ...(modelTarget === "subagents" ? ["inherit"] : []),
    ...context.models.providers(),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const provider = await guided.askInput({
    label: `${modelTargets[modelTarget]} provider`,
    choices: providerChoices,
    validate: (value) =>
      providerChoices.includes(value) ? null : `Choose ${providerChoices.join(" or ")}.`,
  });
  if (provider === null) return;
  if (provider === "inherit") {
    if (await context.models.configure("subagents", null)) {
      context.emit({
        type: "notice",
        text: "Subagents now inherit the primary provider and model on new work.",
      });
    }
    return;
  }

  const modelChoices = [
    ...(selected?.provider === provider ? [selected.model] : []),
    ...context.models.modelSuggestions(provider),
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  const model = await guided.askInput({
    label: `${modelTargets[modelTarget]} model ID`,
    choices: modelChoices,
    validate: (value) => (value.trim().length > 0 ? null : "Model ID is required."),
  });
  if (model === null) return;
  const selection = { provider, model: model.trim() };
  if (await context.models.configure(modelTarget, selection)) {
    context.emit({
      type: "notice",
      text: `${modelTargets[modelTarget]} will use ${selection.provider}/${selection.model} on new work.`,
    });
  }
};
