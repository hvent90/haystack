// MUST stay first: kills react-dom's dev-only per-commit props-diff serialization (a ~1.1 s
// stall per field cell-cross on the 50k asteroid array). See the module comment.
import "./dev-perf-track-off";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing root element.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
