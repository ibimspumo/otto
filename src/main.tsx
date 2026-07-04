import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PanelApp from "./PanelApp";
import SurfaceApp from "./SurfaceApp";
import SettingsApp from "./SettingsApp";

import "./styles.css";

// Mehrere Fenster, eine Codebasis: ?panel=1 → Drop-Shelf,
// ?surface=… → Presence-Stage-Surface, ?settings=1 → Einstellungen,
// sonst die Insel (main).
const params = new URLSearchParams(window.location.search);
const root = params.has("panel") ? (
  <PanelApp />
) : params.has("surface") ? (
  <SurfaceApp />
) : params.has("settings") ? (
  <SettingsApp />
) : (
  <App />
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
