import { useThree } from "@react-three/fiber";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AudioContext as ThreeAudioContext, AudioListener, PositionalAudio } from "three";

import { createSpatialDrone, type SpatialDrone, type SpatialDroneState } from "../../audio/spatial";

const ListenerContext = createContext<AudioListener | null>(null);

/** Mounts an AudioListener on the camera over the shared context; provides it downward. */
export function AudioListenerRig({
  ctx,
  volume,
  children,
}: {
  ctx: AudioContext;
  volume: number;
  children: ReactNode;
}): ReactNode {
  const camera = useThree((state) => state.camera);
  const [listener, setListener] = useState<AudioListener | null>(null);

  useEffect(() => {
    ThreeAudioContext.setContext(ctx);
    const created = new AudioListener();
    camera.add(created);
    setListener(created);
    return () => {
      camera.remove(created);
      setListener(null);
    };
  }, [camera, ctx]);

  useEffect(() => {
    listener?.setMasterVolume(volume);
  }, [listener, volume]);

  return <ListenerContext.Provider value={listener}>{children}</ListenerContext.Provider>;
}

/** A positional engine voice for one remote ship; lives inside the ship's group. */
export function RemoteShipAudio({
  ctx,
  state,
}: {
  ctx: AudioContext;
  state: SpatialDroneState;
}): ReactNode {
  const listener = useContext(ListenerContext);
  const groupRef = useRef<import("three").Group | null>(null);
  const droneRef = useRef<SpatialDrone | null>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (group === null || listener === null) {
      return undefined;
    }
    // Build the drone on the LISTENER's context, not the `ctx` prop: PositionalAudio
    // derives its context from the listener, and connecting nodes across two different
    // (or a closed) AudioContext throws and takes down the whole Canvas. The listener's
    // context and the prop are normally the same, but a teardown/HMR/StrictMode remount
    // can briefly skew them (the engine closes + recreates its context on dispose). Using
    // listener.context guarantees they match; the try/catch is a last-resort guard so a
    // transient mismatch silently skips this voice instead of crashing the scene.
    const positional = new PositionalAudio(listener);
    positional.setRefDistance(0.6);
    positional.setRolloffFactor(1.6);
    positional.setMaxDistance(40);
    let drone: SpatialDrone;
    try {
      drone = createSpatialDrone(listener.context);
      // three's setNodeSource is typed for AudioScheduledSourceNode, but at runtime it
      // only assigns `source` and calls connect() — a GainNode (our drone output) works.
      positional.setNodeSource(drone.output as AudioScheduledSourceNode);
    } catch {
      return undefined;
    }
    group.add(positional);
    droneRef.current = drone;
    drone.setState(state);
    return () => {
      droneRef.current = null;
      drone.dispose();
      group.remove(positional);
      try {
        positional.disconnect();
      } catch {
        // already disconnected
      }
    };
  }, [ctx, listener]);

  useEffect(() => {
    droneRef.current?.setState(state);
  }, [state]);

  if (listener === null) {
    return null;
  }
  return <group ref={groupRef} />;
}
