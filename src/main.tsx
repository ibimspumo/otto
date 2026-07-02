import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PanelApp from "./PanelApp";
import SettingsApp from "./SettingsApp";

import "./styles.css";

// Drei Fenster, eine Codebasis: ?panel=1 → Drops/Quick Look,
// ?settings=1 → Einstellungen, sonst die Insel (main).
const params = new URLSearchParams(window.location.search);
const root = params.has("panel") ? (
  <PanelApp />
) : params.has("settings") ? (
  <SettingsApp />
) : (
  <App />
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
