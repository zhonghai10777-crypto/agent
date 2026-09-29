import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./dev-reload-hook";
import "./styles.css";
import { usesWindowControlsOverlay } from "./ipc";

// Set before the first render so the topbar never lays out under the caption buttons.
if (window.piApp && usesWindowControlsOverlay(window.piApp.platform)) {
  document.documentElement.dataset.windowControls = "overlay";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
