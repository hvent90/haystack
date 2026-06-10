// MUST stay first: kills react-dom's dev-only per-commit props-diff serialization (a ~1.1 s
// stall per field cell-cross on the 50k asteroid array). See the module comment.
import "./dev-perf-track-off";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing root element.");
}

// NB: StrictMode does NOT wrap here — it is applied INSIDE EveApp around the UI-overlay tree
// only, deliberately excluding the WebGPU <Canvas> (WorldView). React StrictMode dev double-
// mounts (mount → unmount → remount) the host tree; for R3F that tears the renderer down and
// fires a delayed (500 ms) `dispose(scene)` against the REUSED renderer, destroying GPU buffers
// mid-submit → "[Buffer] used in submit while destroyed". Keeping the Canvas out of StrictMode
// makes it mount exactly once while the rest of the React UI keeps StrictMode's dev checks.
createRoot(root).render(<App />);
