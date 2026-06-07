import { useEffect, useMemo, useState } from "react";

import { AudioEngine } from "./AudioEngine";
import { deserializeMix, serializeMix, type MixState } from "./mix";

const MIX_KEY = "haystack:audio:mix";

export interface AudioApi {
  engine: AudioEngine;
  mix: MixState;
  setMix: (next: MixState) => void;
  unlocked: boolean;
}

function loadMix(): MixState {
  if (typeof window === "undefined") {
    return deserializeMix(null);
  }
  return deserializeMix(window.localStorage.getItem(MIX_KEY));
}

export function useAudio(): AudioApi {
  const engine = useMemo(() => new AudioEngine(loadMix()), []);
  const [mix, setMixState] = useState<MixState>(() => engine.getMix());
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void engine.init();

    const onGesture = (): void => {
      void engine.unlock().then(() => {
        if (!cancelled) {
          setUnlocked(true);
        }
      });
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      engine.dispose();
    };
  }, [engine]);

  const setMix = (next: MixState): void => {
    engine.setMix(next);
    setMixState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MIX_KEY, serializeMix(next));
    }
  };

  return { engine, mix, setMix, unlocked };
}
