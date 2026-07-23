import { NavLink, Outlet, useLocation, Link } from "react-router";

const NAV = [
  { to: "/install", label: "install" },
  { to: "/quickstart", label: "quickstart" },
  { to: "/modes", label: "modes" },
  { to: "/cli", label: "cli" },
  { to: "/config", label: "config" },
  { to: "/mcp", label: "mcp" },
];

function Breadcrumbs() {
  const { pathname } = useLocation();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  const crumbs = segments.slice(0, -1).map((seg, i) => ({
    label: seg,
    to: "/" + segments.slice(0, i + 1).join("/"),
  }));

  return (
    <nav className="breadcrumbs">
      <Link to="/">glrs</Link>
      {crumbs.map(({ label, to }) => (
        <span key={to}>
          {" / "}
          <Link to={to}>{label}</Link>
        </span>
      ))}
      {" / "}
      <span>{segments[segments.length - 1]}</span>
    </nav>
  );
}

export function Layout() {
  return (
    <>
      <header className="site-header">
        <NavLink to="/" className="logo">
          glrs
        </NavLink>
        <nav>
          {NAV.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Breadcrumbs />
      <Outlet />
      <footer className="site-footer">
        <span className="footer-mark">glorious</span>
      </footer>
    </>
  );
}
