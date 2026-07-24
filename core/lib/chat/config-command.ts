import { type ConfigField, configField } from "../config/fields";
import type { ConfigCliHandlers, ConfigCliResult } from "../config-cli";
import { type ListEditorAction, type ListEditorState, reduceListEditor } from "../tui/list-editor";
import { listOverflowFooter, windowList } from "../tui/list-window";
import type { ChatCommandContext } from "./command-context";

export const configActions = {
  get: "Read a global configuration value",
  set: "Set a global configuration value",
  delete: "Delete a global configuration value",
} as const;

const splitHead = (value: string): [string, string] => {
  const match = value.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return [match?.[1] ?? "", match?.[2] ?? ""];
};

export const isSensitiveConfigPath = (key: string): boolean =>
  /(?:^|\.)(?:headers|env)(?:\.|$)/u.test(key) ||
  /(?:api[_-]?key|token|secret|password)/iu.test(key);
const successful = (result: ConfigCliResult): boolean => result.ok;

const reloadConfigPath = async (context: ChatCommandContext, key: string): Promise<void> => {
  if (!key.startsWith("mcp.")) return;
  const match = key.match(/^mcp\.servers\.([A-Za-z0-9_-]+)/u);
  await context.mcp?.reload(match?.[1]);
};

const listEditorLabel = (key: string, state: ListEditorState): string => {
  const window = windowList(state.items, state.cursor);
  const items = window.items.map((item, index) => {
    const selected = window.start + index === state.cursor ? ">" : " ";
    return `${selected} ${item}`;
  });
  const overflow = listOverflowFooter(window);
  return [
    `Edit ${key}`,
    ...(items.length ? items : ["(no items)"]),
    ...(overflow ? [overflow] : []),
  ].join("\n");
};

const editStringArray = async (
  context: ChatCommandContext,
  key: string,
  initial: readonly string[],
): Promise<string[] | null> => {
  if (!context.guided) {
    context.emit({ type: "notice", text: "Guided input is unavailable in this session." });
    return null;
  }
  const guided = context.guided;
  let state: ListEditorState = { items: [...initial], cursor: 0 };
  while (true) {
    const actions = [
      "add",
      ...(state.items.length ? ["edit", "delete", "select up", "select down"] : []),
      ...(state.items.length > 1 ? ["move item up", "move item down"] : []),
      "save",
    ];
    const action = await guided.askInput({
      label: listEditorLabel(key, state),
      choices: actions,
      validate: (value) => (actions.includes(value) ? null : "Choose a list action."),
    });
    if (action === null) return null;
    if (action === "save") return state.items;
    const commands: Record<string, Exclude<ListEditorAction, { item: string }>["type"]> = {
      "select up": "move-up",
      "select down": "move-down",
      "move item up": "reorder-up",
      "move item down": "reorder-down",
      delete: "delete",
    };
    const kind = commands[action];
    if (kind) {
      state = reduceListEditor(state, { type: kind });
      continue;
    }
    const item = await guided.askInput({
      label: action === "add" ? `Add item to ${key}` : `Edit item in ${key}`,
      validate: (value) => (value.trim() ? null : "An item is required."),
    });
    if (item === null) return null;
    state = reduceListEditor(state, { type: action === "add" ? "add" : "edit", item: item.trim() });
  }
};

const requireConfig = (context: ChatCommandContext): ConfigCliHandlers | null => {
  if (!context.config) {
    context.emit({ type: "notice", text: "Configuration is unavailable in this session." });
    return null;
  }
  return context.config as ConfigCliHandlers;
};

export const runConfigCommand = async (
  context: ChatCommandContext,
  args: string,
): Promise<void> => {
  const [action, remainder] = splitHead(args);
  if (!action && context.launchConfigTui) {
    // Bare `/config` opens the full-screen interactive editor.
    await context.launchConfigTui();
    return;
  }
  if (!(action in configActions)) {
    context.emit({ type: "notice", text: "Usage: /config get|set|delete <path> [JSON value]" });
    return;
  }
  const handlers = requireConfig(context);
  if (!handlers) return;
  const [key, suppliedValue] = splitHead(remainder);
  if (!key) {
    context.emit({
      type: "notice",
      text: `Usage: /config ${action} <path>${action === "set" ? " [JSON value]" : ""}`,
    });
    return;
  }
  if (action === "get") {
    if (isSensitiveConfigPath(key) || key === "mcp" || key.startsWith("mcp.servers")) {
      context.emit({ type: "notice", text: `${key} is sensitive and cannot be displayed.` });
      return;
    }
    await handlers.get({ key });
    return;
  }
  if (action === "delete") {
    const result = await handlers.delete({ key });
    if (successful(result)) await reloadConfigPath(context, key);
    return;
  }
  if (key === "providers.azure.api_key" || key === "agent.llm.providers.azure.apiKey") {
    const result = await handlers.set({ key, secret: true });
    if (successful(result)) await reloadConfigPath(context, key);
    return;
  }
  let field: ConfigField | undefined;
  try {
    field = configField(key);
  } catch {
    field = undefined;
  }
  if (field?.kind === "string-array") {
    const current = await handlers.get({ key });
    if (
      !current.ok ||
      !Array.isArray(current.value) ||
      !current.value.every((item) => typeof item === "string")
    )
      return;
    const items = await editStringArray(context, key, current.value);
    if (items === null) {
      context.emit({ type: "notice", text: "Configuration update cancelled." });
      return;
    }
    const result = await handlers.set({ key, value: JSON.stringify(items) });
    if (successful(result)) await reloadConfigPath(context, key);
    return;
  }
  let value = suppliedValue;
  if (!value) {
    if (!context.guided) {
      context.emit({ type: "notice", text: "Guided input is unavailable in this session." });
      return;
    }
    const entered = await context.guided.askInput({
      label: `Value for ${key}`,
      masked: isSensitiveConfigPath(key),
    });
    if (entered === null) {
      context.emit({ type: "notice", text: "Configuration update cancelled." });
      return;
    }
    value = isSensitiveConfigPath(key) ? JSON.stringify(entered) : entered;
  }
  const result = await handlers.set({ key, value });
  if (successful(result)) await reloadConfigPath(context, key);
};
