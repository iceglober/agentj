import { configField } from "../config/fields";
import { CONFIG_DOCS, type ConfigDoc } from "../config/reference";
import type { GuidedInputPort } from "./guided-input";

/**
 * The `glorious config` interactive editor. It builds a navigable tree from the
 * curated documentation paths and uses an injected guided-input port, keeping
 * config policy and terminal rendering outside this pure flow.
 */

export interface ConfigUiPort extends GuidedInputPort {
  /** Current typed value of a config key. */
  read(path: string): Promise<unknown>;
  /** Persist a non-secret value as its string form (arrays as JSON). */
  apply(path: string, value: string): Promise<boolean>;
  /** Persist a value collected with a masked prompt. */
  applySecret(path: string, value: string): Promise<boolean>;
  note(text: string): void;
}

interface ConfigMenuNode {
  children: Map<string, ConfigMenuNode>;
  doc?: ConfigDoc;
}

const display = (value: unknown): string => {
  if (value === undefined || value === null) return "unset";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "empty";
  if (typeof value === "string") return value.length > 0 ? value : "empty";
  return String(value);
};

const createMenuTree = (): ConfigMenuNode => {
  const root: ConfigMenuNode = { children: new Map() };
  for (const doc of CONFIG_DOCS) {
    let node = root;
    for (const segment of doc.path.split(".")) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.doc = doc;
  }
  return root;
};

const promptLabel = (label: string): string => label;

const editArray = async (port: ConfigUiPort, path: string): Promise<void> => {
  const current = await port.read(path);
  const items = Array.isArray(current) ? current.map(String) : [];
  while (true) {
    const action = await port.askInput({
      label: promptLabel(`${path} — ${items.join(", ") || "(no items)"}`),
      choices: [
        "add an item",
        ...(items.length > 0 ? ["remove an item"] : []),
        `save (${items.length} item${items.length === 1 ? "" : "s"})`,
      ],
    });
    if (action === null) return;
    if (action.startsWith("save (")) {
      await port.apply(path, JSON.stringify(items));
      port.note("Reorder items with /config inside a session.");
      return;
    }
    if (action === "add an item") {
      const item = await port.askInput({ label: promptLabel(`Add to ${path}`) });
      if (item?.trim()) items.push(item.trim());
      continue;
    }
    const which = await port.askInput({
      label: promptLabel(`Remove from ${path}`),
      choices: items,
    });
    if (which !== null) items.splice(items.indexOf(which), 1);
  }
};

const editKey = async (port: ConfigUiPort, path: string): Promise<void> => {
  const field = configField(path);
  if (field.kind === "record") {
    port.note(`${path} is a structured value — edit it with /config in a session, or config set.`);
    return;
  }
  if (field.kind === "string-array") return editArray(port, path);
  if (field.secret) {
    const value = await port.askInput({
      label: promptLabel(`New value for ${path}`),
      masked: true,
    });
    if (value?.trim()) await port.applySecret(path, value.trim());
    return;
  }
  if (field.kind === "enum" && field.enumValues) {
    const current = await port.read(path);
    const chosen = await port.askInput({
      label: promptLabel(field.description ?? path),
      choices: field.enumValues,
      ...(typeof current === "string" ? { initial: current } : {}),
    });
    if (chosen !== null) await port.apply(path, chosen);
    return;
  }
  if (field.kind === "boolean") {
    const current = await port.read(path);
    const chosen = await port.askInput({
      label: promptLabel(field.description ?? path),
      choices: ["true", "false"],
      ...(typeof current === "boolean" ? { initial: String(current) } : {}),
    });
    if (chosen !== null) await port.apply(path, chosen);
    return;
  }
  const current = await port.read(path);
  const value = await port.askInput({
    label: promptLabel(field.kind === "number" ? `${path} (a number)` : path),
    ...(current === undefined ? {} : { initial: String(current) }),
  });
  if (value === null) return;
  if (field.kind === "number" && !Number.isFinite(Number(value))) {
    port.note(`${value} is not a number.`);
    return;
  }
  await port.apply(path, value.trim());
};

const browse = async (
  port: ConfigUiPort,
  node: ConfigMenuNode,
  segments: readonly string[],
): Promise<void> => {
  while (true) {
    const choices = await Promise.all(
      [...node.children].map(async ([segment, child]) =>
        child.doc
          ? {
              label: `${segment} = ${display(await port.read(child.doc.path))}`,
              value: segment,
              description: child.doc.description,
            }
          : { label: segment, value: segment },
      ),
    );
    const chosen = await port.askInput({
      label: promptLabel(segments.length === 0 ? "glorious configuration" : segments.join(".")),
      choices,
    });
    if (chosen === null) return;
    const child = node.children.get(chosen);
    if (!child) continue;
    if (child.doc) await editKey(port, child.doc.path);
    else await browse(port, child, [...segments, chosen]);
  }
};

export async function runConfigUi(port: ConfigUiPort): Promise<void> {
  await browse(port, createMenuTree(), []);
}
