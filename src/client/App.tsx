import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { EveApp } from "./eve/EveApp";
import { hasWebGPU } from "./eve/gpu/capability";

// WebGPU is required — there is no WebGL fallback (docs/gpu-asteroids-architecture.md §1.1/§5).
// The app refuses to start on a browser without WebGPU rather than degrading to a second path.
export function App(): ReactNode {
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    hasWebGPU().then(
      (ok) => {
        if (!cancelled) setSupported(ok);
      },
      () => {
        if (!cancelled) setSupported(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (supported === null) {
    return null; // brief capability probe; nothing to show yet
  }

  if (!supported) {
    return (
      <div
        role="alert"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          padding: "24px",
          textAlign: "center",
          font: "16px/1.5 system-ui, sans-serif",
          color: "#ddd",
          background: "#03040a",
        }}
      >
        This application requires WebGPU; your browser does not support it. Try the latest Chrome
        or Edge with hardware acceleration enabled.
      </div>
    );
  }

  return <EveApp />;
}
