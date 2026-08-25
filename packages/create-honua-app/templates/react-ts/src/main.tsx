import "./maplibre-worker.js";
import "maplibre-gl/dist/maplibre-gl.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

// StrictMode double-invokes effects in development. App owns cancellation and
// SDK disposal, so the mount/unmount/mount cycle never leaks a map source.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
