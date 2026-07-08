import React from "react";
import ReactDOM from "react-dom/client";
// Self-hosted fonts (no CDN): grotesk chrome + mono workbench.
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
