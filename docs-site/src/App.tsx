import { BrowserRouter, Routes, Route } from "react-router";
import { PkgManagerProvider } from "./components/PkgManager";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Install } from "./pages/Install";
import { Doc } from "./pages/Doc";
import { Changelog } from "./pages/Changelog";

import quickstartMd from "./content/quickstart.md?raw";
import harnessMd from "./content/harness.md?raw";
import agentsMd from "./content/agents.md?raw";
import configMd from "./content/config.md?raw";
import commandsMd from "./content/commands.md?raw";
import skillsMd from "./content/skills.md?raw";
import toolsMd from "./content/tools.md?raw";
import autopilotMd from "./content/autopilot.md?raw";
import cliMd from "./content/cli.md?raw";
import assumeMd from "./content/assume.md?raw";
import headroomMd from "./content/headroom.md?raw";

export function App() {
  return (
    <PkgManagerProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="install" element={<Install />} />
            <Route path="quickstart" element={<Doc md={quickstartMd} title="quickstart" />} />
            <Route path="harness" element={<Doc md={harnessMd} title="harness" />} />
            <Route path="harness/agents" element={<Doc md={agentsMd} title="agents" />} />
            <Route path="harness/config" element={<Doc md={configMd} title="config" />} />
            <Route path="harness/commands" element={<Doc md={commandsMd} title="commands" />} />
            <Route path="harness/skills" element={<Doc md={skillsMd} title="skills" />} />
            <Route path="harness/tools" element={<Doc md={toolsMd} title="tools" />} />
            <Route path="autopilot" element={<Doc md={autopilotMd} title="autopilot" />} />
            <Route path="headroom" element={<Doc md={headroomMd} title="headroom" />} />
            <Route path="cli" element={<Doc md={cliMd} title="cli" />} />
            <Route path="assume" element={<Doc md={assumeMd} title="assume" />} />
            <Route path="changelog" element={<Changelog />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PkgManagerProvider>
  );
}
