import "maplibre-gl/dist/maplibre-gl.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root container");
}

// StrictMode is intentional: it double-invokes mount/unmount in dev, exercising
// the SDK's StrictMode-safe provider, hooks, and map lifecycle.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
