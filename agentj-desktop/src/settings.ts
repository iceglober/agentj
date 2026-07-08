// Display preferences that shape the transcript. Persisted to localStorage so
// they survive reloads; all default ON.

import { useCallback, useState } from "react";

export interface Settings {
  showThinking: boolean;
  showTools: boolean;
  autoScroll: boolean;
}

const KEY = "agentj.settings";

const DEFAULTS: Settings = {
  showThinking: true,
  showTools: true,
  autoScroll: true,
};

function load(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      showThinking: typeof v.showThinking === "boolean" ? v.showThinking : DEFAULTS.showThinking,
      showTools: typeof v.showTools === "boolean" ? v.showTools : DEFAULTS.showTools,
      autoScroll: typeof v.autoScroll === "boolean" ? v.autoScroll : DEFAULTS.autoScroll,
    };
  } catch {
    return DEFAULTS;
  }
}

export interface SettingsStore {
  settings: Settings;
  set: (key: keyof Settings, value: boolean) => void;
}

export function useSettings(): SettingsStore {
  const [settings, setSettings] = useState<Settings>(load);

  const set = useCallback((key: keyof Settings, value: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { settings, set };
}
