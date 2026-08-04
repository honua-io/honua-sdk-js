import "maplibre-gl/dist/maplibre-gl.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

// StrictMode double-invokes effects in development. The SDK's React hooks are
// StrictMode-safe, so the mount/unmount/mount cycle never leaks a map source.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
