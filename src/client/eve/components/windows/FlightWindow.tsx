import type { ReactNode } from "react";
import { Crosshair, Gauge, LocateFixed, Rocket } from "lucide-react";
import type { Ship, Vector3 } from "../../../../shared/types";
import type { FlightMode } from "../../types";
import { meters, vectorMagnitude } from "../../vector";
import { StatGrid } from "../StatGrid";

export function FlightWindow({
  myShip,
  flightMode,
  throttle,
  cruiseLock,
  canUse,
  onRequestFlightLock,
  onThrust,
  onThrottleDown,
  onThrottleZero,
  onThrottleUp,
  onBoost,
  onCruiseToggle,
  onResetToOrigin,
}: {
  myShip: Ship;
  flightMode: FlightMode;
  throttle: number;
  cruiseLock: boolean;
  canUse: boolean;
  onRequestFlightLock: () => void;
  onThrust: (impulse: Vector3, stabilize?: boolean) => void;
  onThrottleDown: () => void;
  onThrottleZero: () => void;
  onThrottleUp: () => void;
  onBoost: () => void;
  onCruiseToggle: () => void;
  onResetToOrigin: () => void;
}): ReactNode {
  return (
    <>
      <div className="flight-controls">
        <button
          type="button"
          data-testid="flight-mode-toggle"
          disabled={!canUse}
          onClick={onRequestFlightLock}
        >
          {flightMode === "flight" ? "Flight mode active" : "Enter flight mode"}
        </button>
        <button type="button" disabled={!canUse} onClick={onThrottleDown}>
          -25%
        </button>
        <button type="button" disabled={!canUse} onClick={onThrottleZero}>
          0%
        </button>
        <button type="button" disabled={!canUse} onClick={onThrottleUp}>
          +25%
        </button>
        <button type="button" disabled={!canUse || myShip.heat >= 96} onClick={onBoost}>
          <Rocket size={14} />
          Boost
        </button>
        <button
          type="button"
          className={cruiseLock ? "active" : ""}
          disabled={!canUse}
          onClick={onCruiseToggle}
        >
          <Gauge size={14} />
          Cruise
        </button>
        <button
          type="button"
          className="danger"
          disabled={!canUse}
          onClick={() => onThrust({ x: 0, y: 0, z: 0 }, true)}
        >
          <Crosshair size={14} />
          Stabilize
        </button>
        <button
          type="button"
          data-testid="flight-reset-origin"
          disabled={!canUse}
          onClick={onResetToOrigin}
          title="Reset position to origin and clear all movement"
        >
          <LocateFixed size={14} />
          Recenter
        </button>
      </div>
      <StatGrid
        rows={[
          ["Speed", `${vectorMagnitude(myShip.velocity).toFixed(1)} m/s`],
          ["Velocity", meters(myShip.velocity)],
          ["Angular", meters(myShip.angularVelocity)],
          ["Position", meters(myShip.position)],
          ["Heat", myShip.heat.toFixed(1)],
          ["Throttle", `${(throttle * 100).toFixed(0)}%`],
          ["Scanner", `${myShip.scanPower.toFixed(2)}x`],
          ["Mining", `${myShip.miningPower.toFixed(1)}t`],
        ]}
      />
    </>
  );
}
