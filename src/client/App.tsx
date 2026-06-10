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
    // WebGPU-only, by design — accurate per-platform guidance instead of a one-liner.
    // Wording of the first sentence is part of the §8.2 contract (capability.ts).
    return (
      <div role="alert" className="unsupported-screen" data-testid="unsupported-screen">
        <div className="unsupported-card">
          <div className="unsupported-mark">H</div>
          <h1>Haystack needs WebGPU</h1>
          <p>This application requires WebGPU; your browser does not support it.</p>
          <ul>
            <li>
              <b>iPhone / iPad</b> — Safari on iOS 26 or later
            </li>
            <li>
              <b>Android</b> — Chrome 121 or later
            </li>
            <li>
              <b>Desktop</b> — Chrome or Edge 113+, Safari 26+, or Firefox 141+ (Windows), with
              hardware acceleration enabled
            </li>
          </ul>
          <p className="unsupported-hint">
            Already on one of these? Make sure hardware acceleration is on and try reloading.
          </p>
        </div>
      </div>
    );
  }

  return <EveApp />;
}
