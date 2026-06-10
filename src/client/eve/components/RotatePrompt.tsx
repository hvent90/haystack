import { RefreshCw, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

// Landscape is the primary orientation: dual-stick flight needs both thumbs at the
// screen's sides, and the HUD/window layouts assume width. Rather than shipping a
// second, cramped portrait layout, portrait on touch devices gets a full-screen
// rotate prompt (the windows/HUD underneath stay mounted — rotating back resumes
// instantly with no state loss).
export function RotatePrompt(): ReactNode {
  const [portrait, setPortrait] = useState(() => isPortrait());

  useEffect(() => {
    const query = window.matchMedia("(orientation: portrait)");
    const update = (): void => setPortrait(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  if (!portrait) {
    return null;
  }
  return (
    <div className="rotate-prompt" data-testid="rotate-prompt" role="alert">
      <div className="rotate-prompt-glyph" aria-hidden="true">
        <Smartphone size={48} />
        <RefreshCw size={22} />
      </div>
      <div className="rotate-prompt-title">Rotate your device</div>
      <div className="rotate-prompt-body">Haystack flies in landscape.</div>
    </div>
  );
}

function isPortrait(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(orientation: portrait)").matches;
}
