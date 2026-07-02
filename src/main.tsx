import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MiniOrb from "./MiniOrb";

import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";

const isMini = new URLSearchParams(window.location.search).has("mini");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isMini ? <MiniOrb /> : <App />}</React.StrictMode>,
);
