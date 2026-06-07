import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Gauge,
  Rocket,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { Ship, Vector3 } from "../../../shared/types";
import type { FlightMode } from "../types";
import { meters, vectorMagnitude } from "../vector";

export function HudCluster({
  myShip,
  canUse,
  flightMode,
  throttle,
  cruiseLock,
  onThrust,
  onThrottleDown,
  onThrottleZero,
  onThrottleUp,
  onBoost,
  onCruiseToggle,
}: {
  myShip: Ship;
  canUse: boolean;
  flightMode: FlightMode;
  throttle: number;
  cruiseLock: boolean;
  onThrust: (impulse: Vector3, stabilize?: boolean) => void;
  onThrottleDown: () => void;
  onThrottleZero: () => void;
  onThrottleUp: () => void;
  onBoost: () => void;
  onCruiseToggle: () => void;
}): ReactNode {
  const speed = vectorMagnitude(myShip.velocity);
  const heat = Math.max(0, Math.min(100, myShip.heat));
  return (
    <section className="hud-cluster" data-testid="hud-cluster" aria-label="Manual thrust HUD">
      <div
        className="heat-gauge"
        data-testid="hud-heat-gauge"
        style={{ "--heat": `${heat * 3.6}deg` } as CSSProperties}
      >
        <span>{myShip.heat.toFixed(1)}</span>
        <small>heat</small>
      </div>
      <div className="hud-readouts">
        <div data-testid="hud-speed" data-speed={speed}>
          {speed.toFixed(1)} m/s
        </div>
        <div data-testid="hud-flight-mode">{flightMode}</div>
        <div data-testid="hud-throttle" data-throttle={throttle}>
          {(throttle * 100).toFixed(0)}% {cruiseLock ? "CRZ" : "MAN"}
        </div>
        <div
          data-testid="hud-velocity"
          data-vx={myShip.velocity.x}
          data-vy={myShip.velocity.y}
          data-vz={myShip.velocity.z}
        >
          v {meters(myShip.velocity)}
        </div>
        <div
          data-testid="hud-position"
          data-x={myShip.position.x}
          data-y={myShip.position.y}
          data-z={myShip.position.z}
        >
          p {meters(myShip.position)}
        </div>
      </div>
      <div className="hud-buttons">
        <button
          type="button"
          data-testid="hud-thrust-fwd"
          aria-label="Forward impulse"
          title="Forward impulse"
          disabled={!canUse}
          onClick={() => onThrust({ x: 0, y: 0, z: -8 })}
        >
          <ChevronUp size={18} />
        </button>
        <button
          type="button"
          data-testid="hud-thrust-left"
          aria-label="Left impulse"
          title="Left impulse"
          disabled={!canUse}
          onClick={() => onThrust({ x: -8, y: 0, z: 0 })}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          data-testid="hud-thrust-rev"
          aria-label="Reverse impulse"
          title="Reverse impulse"
          disabled={!canUse}
          onClick={() => onThrust({ x: 0, y: 0, z: 8 })}
        >
          <ChevronDown size={18} />
        </button>
        <button
          type="button"
          data-testid="hud-thrust-right"
          aria-label="Right impulse"
          title="Right impulse"
          disabled={!canUse}
          onClick={() => onThrust({ x: 8, y: 0, z: 0 })}
        >
          <ChevronRight size={18} />
        </button>
        <button
          type="button"
          data-testid="hud-thrust-up"
          aria-label="Up impulse"
          title="Up impulse"
          disabled={!canUse}
          onClick={() => onThrust({ x: 0, y: 5, z: 0 })}
        >
          +Y
        </button>
        <button
          type="button"
          data-testid="hud-thrust-down"
          aria-label="Down impulse"
          title="Down impulse"
          disabled={!canUse}
          onClick={() => onThrust({ x: 0, y: -5, z: 0 })}
        >
          -Y
        </button>
        <button
          type="button"
          className="hud-stabilize"
          data-testid="hud-stabilize"
          aria-label="Stabilize"
          title="Stabilize"
          disabled={!canUse}
          onClick={() => onThrust({ x: 0, y: 0, z: 0 }, true)}
        >
          <Crosshair size={16} />
        </button>
        <button
          type="button"
          aria-label="Throttle down"
          title="Throttle down"
          disabled={!canUse}
          onClick={onThrottleDown}
        >
          -%
        </button>
        <button
          type="button"
          aria-label="Throttle zero"
          title="Throttle zero"
          disabled={!canUse}
          onClick={onThrottleZero}
        >
          0
        </button>
        <button
          type="button"
          aria-label="Throttle up"
          title="Throttle up"
          disabled={!canUse}
          onClick={onThrottleUp}
        >
          +%
        </button>
        <button
          type="button"
          aria-label="Boost"
          title="Boost"
          disabled={!canUse || myShip.heat >= 96}
          onClick={onBoost}
        >
          <Rocket size={15} />
        </button>
        <button
          type="button"
          className={cruiseLock ? "active" : ""}
          aria-label="Cruise lock"
          title="Cruise lock"
          disabled={!canUse}
          onClick={onCruiseToggle}
        >
          <Gauge size={15} />
        </button>
      </div>
    </section>
  );
}
