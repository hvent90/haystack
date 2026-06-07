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
      return;
    }
    const positional = new PositionalAudio(listener);
    positional.setRefDistance(0.6);
    positional.setRolloffFactor(1.6);
    positional.setMaxDistance(40);
    const drone = createSpatialDrone(ctx);
    // three's setNodeSource is typed for AudioScheduledSourceNode, but at runtime it
    // only assigns `source` and calls connect() — a GainNode (our drone output) works.
    positional.setNodeSource(drone.output as AudioScheduledSourceNode);
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
