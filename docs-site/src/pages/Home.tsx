import { Link } from "react-router";
import { PkgSwitcher, Cmd } from "~/components/PkgManager";
import { NpmVersions } from "~/components/NpmVersions";

export function Home() {
  const copyBash = () =>
    navigator.clipboard.writeText("curl -fsSL https://glrs.dev/install.sh | bash");

  return (
    <main className="home">
      <div className="home-hero">
        <h1>glrs</h1>
        <p className="tagline">glorious tools for tomorrow</p>
      </div>

      <NpmVersions />

      <div className="install-block">
        <div className="install-cmd" onClick={copyBash} title="copy to clipboard">
          curl -fsSL https://glrs.dev/install.sh | bash
        </div>
        <div className="install-alt">
          <div className="install-or">or via package manager:</div>
          <div className="install-alt-row">
            <PkgSwitcher />
            <Cmd action="install" pkg="@glrs-dev/cli" />
          </div>
        </div>
      </div>

      <hr />

      <div className="links">
        <Link to="/install">install</Link>
        <Link to="/quickstart">quickstart</Link>
        <Link to="/harness">agent harness</Link>
        <Link to="/harness/agents">agents</Link>
        <Link to="/harness/commands">commands</Link>
        <Link to="/harness/skills">skills</Link>
        <Link to="/harness/tools">tools</Link>
        <Link to="/harness/config">configuration</Link>
        <Link to="/autopilot">autopilot</Link>
        <Link to="/headroom">headroom (compression)</Link>
        <Link to="/cli">cli</Link>
        <Link to="/assume">assume (sso)</Link>
      </div>

      <div className="external">
        <Link to="/changelog">changelog</Link>
        {" · "}
        <a href="https://github.com/iceglober/glorious">github</a>
      </div>
    </main>
  );
}
