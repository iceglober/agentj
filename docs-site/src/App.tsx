import { BrowserRouter, Routes, Route } from "react-router";
import { PkgManagerProvider } from "./components/PkgManager";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Install } from "./pages/Install";
import { Doc } from "./pages/Doc";
import { Changelog } from "./pages/Changelog";

import quickstartMd from "./content/quickstart.md?raw";
import modesMd from "./content/modes.md?raw";
import permissionsMd from "./content/permissions.md?raw";
import subagentsMd from "./content/subagents.md?raw";
import jobsMd from "./content/jobs.md?raw";
import skillsMd from "./content/skills.md?raw";
import mcpMd from "./content/mcp.md?raw";
import toolsMd from "./content/tools.md?raw";
import cliMd from "./content/cli.md?raw";
import commandsMd from "./content/commands.md?raw";
import configMd from "./content/config.md?raw";
import sessionsMd from "./content/sessions.md?raw";

export function App() {
  return (
    <PkgManagerProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="install" element={<Install />} />
            <Route path="quickstart" element={<Doc md={quickstartMd} title="quickstart" />} />
            <Route path="modes" element={<Doc md={modesMd} title="modes" />} />
            <Route path="permissions" element={<Doc md={permissionsMd} title="permissions" />} />
            <Route path="subagents" element={<Doc md={subagentsMd} title="subagents" />} />
            <Route path="jobs" element={<Doc md={jobsMd} title="jobs" />} />
            <Route path="skills" element={<Doc md={skillsMd} title="skills" />} />
            <Route path="mcp" element={<Doc md={mcpMd} title="mcp" />} />
            <Route path="tools" element={<Doc md={toolsMd} title="tools" />} />
            <Route path="cli" element={<Doc md={cliMd} title="cli" />} />
            <Route path="commands" element={<Doc md={commandsMd} title="commands" />} />
            <Route path="config" element={<Doc md={configMd} title="config" />} />
            <Route path="sessions" element={<Doc md={sessionsMd} title="sessions" />} />
            <Route path="changelog" element={<Changelog />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PkgManagerProvider>
  );
}
