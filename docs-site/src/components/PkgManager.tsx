import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

const MANAGERS = ["npm", "pnpm", "bun", "yarn"] as const;
type Manager = (typeof MANAGERS)[number];

const KEY = "glrs-pkg-manager";

function read(): Manager {
  try {
    const v = localStorage.getItem(KEY);
    if (v && MANAGERS.includes(v as Manager)) return v as Manager;
  } catch {}
  return "npm";
}

const Ctx = createContext<{ mgr: Manager; set: (m: Manager) => void }>({
  mgr: "npm",
  set: () => {},
});

export function PkgManagerProvider({ children }: { children: ReactNode }) {
  const [mgr, setMgr] = useState<Manager>(read);

  const set = (m: Manager) => {
    setMgr(m);
    try { localStorage.setItem(KEY, m); } catch {}
  };

  return <Ctx.Provider value={{ mgr, set }}>{children}</Ctx.Provider>;
}

export function usePkgManager() {
  return useContext(Ctx);
}

export function PkgSwitcher() {
  const { mgr, set } = usePkgManager();

  return (
    <span className="pkg-switcher">
      {MANAGERS.map((m) => (
        <button
          key={m}
          className={m === mgr ? "active" : ""}
          onClick={() => set(m)}
        >
          {m}
        </button>
      ))}
    </span>
  );
}

const INSTALL_GLOBAL: Record<Manager, (pkg: string) => string> = {
  npm: (p) => `npm i -g ${p}`,
  pnpm: (p) => `pnpm add -g ${p}`,
  bun: (p) => `bun add -g ${p}`,
  yarn: (p) => `yarn global add ${p}`,
};

const EXEC: Record<Manager, (pkg: string, args: string) => string> = {
  npm: (p, a) => `npx ${p} ${a}`,
  pnpm: (p, a) => `pnpm dlx ${p} ${a}`,
  bun: (p, a) => `bunx ${p} ${a}`,
  yarn: (p, a) => `yarn dlx ${p} ${a}`,
};

const REMOVE_GLOBAL: Record<Manager, (pkg: string) => string> = {
  npm: (p) => `npm rm -g ${p}`,
  pnpm: (p) => `pnpm rm -g ${p}`,
  bun: (p) => `bun rm -g ${p}`,
  yarn: (p) => `yarn global remove ${p}`,
};

const UPDATE_GLOBAL: Record<Manager, (pkg: string) => string> = {
  npm: (p) => `npm update -g ${p}`,
  pnpm: (p) => `pnpm update -g ${p}`,
  bun: (p) => `bun update -g ${p}`,
  yarn: (p) => `yarn global upgrade ${p}`,
};

export function Cmd({ action, pkg, args }: { action: "install" | "exec" | "remove" | "update"; pkg: string; args?: string }) {
  const { mgr } = usePkgManager();
  let cmd: string;

  switch (action) {
    case "install":
      cmd = INSTALL_GLOBAL[mgr](pkg);
      break;
    case "exec":
      cmd = EXEC[mgr](pkg, args ?? "");
      break;
    case "remove":
      cmd = REMOVE_GLOBAL[mgr](pkg);
      break;
    case "update":
      cmd = UPDATE_GLOBAL[mgr](pkg);
      break;
  }

  const copy = () => navigator.clipboard.writeText(cmd);

  return (
    <code className="cmd" onClick={copy} title="copy">
      {cmd}
    </code>
  );
}
