import {
  Camera,
  Crosshair,
  Flashlight,
  Gauge,
  Radar,
  RotateCcw,
  RotateCw,
  Rocket,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import type { ViewMode } from "../cameraStore";
import { squaredAxis, stickRadiusPx, stickVector, type TouchFlightState } from "../touch-input";

// Dual virtual sticks + the discrete flight buttons for touch devices.
//
// The sticks SPAWN WHERE THE THUMB LANDS inside their zone (no fixed pad to find
// blind), and write into the shared TouchFlightState that buildFlightInput reads on the
// input timer. Left stick: vertical = throttle (held override, like W/S), horizontal =
// lateral strafe. Right stick: pitch/yaw with a squared response curve. Roll lives on
// two hold-buttons (left thumb) instead of a stick axis — fine analog roll is not worth
// a whole axis in a belt-mining flight model, and two-finger-twist gestures fight the
// pinch-zoom gesture in third person.
//
// First person only for the zones: in third person the screen belongs to the orbit
// camera gestures (drag/pinch, handled on the world stage), per the camera scoping in
// the mobile design. The button clusters stay in both views.

// Pointer capture keeps a stick tracking when the thumb wanders off its zone; some
// environments (synthesized events in e2e, older Safari) reject the call for pointer
// ids they do not consider active — the stick still works, only un-captured.
function tryCapturePointer(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Non-capturing stick is acceptable.
  }
}

type StickVisual = {
  originX: number;
  originY: number;
  knobX: number;
  knobY: number;
};

type Side = "left" | "right";

export function TouchFlightControls({
  state,
  viewMode,
  throttle,
  cruiseLock,
  flashlightOn,
  onBoost,
  onCruiseToggle,
  onFlashlight,
  onScan,
  onCamera,
}: {
  state: TouchFlightState;
  viewMode: ViewMode;
  throttle: number;
  cruiseLock: boolean;
  flashlightOn: boolean;
  onBoost: () => void;
  onCruiseToggle: () => void;
  onFlashlight: () => void;
  onScan: () => void;
  onCamera: () => void;
}): ReactNode {
  const [sticks, setSticks] = useState<{ left: StickVisual | null; right: StickVisual | null }>({
    left: null,
    right: null,
  });
  const pointerBySide = useRef<{ left: number | null; right: number | null }>({
    left: null,
    right: null,
  });
  const originBySide = useRef<{ left: { x: number; y: number }; right: { x: number; y: number } }>({
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
  });

  function applyAxes(side: Side, dxPx: number, dyPx: number): void {
    const vector = stickVector(dxPx, dyPx);
    if (side === "left") {
      // Stick up = positive throttle; right = strafe right. Linear feels right for
      // translation (throttle is a target rate, not an aim).
      state.throttle = -vector.y;
      state.strafeX = vector.x;
      return;
    }
    // Stick up = pitch up, stick right = yaw right — matching the pointer-locked mouse
    // mapping in EveApp.mouseMove (movementY -> +x deflection, movementX -> -y).
    state.rotation.x = squaredAxis(-vector.y);
    state.rotation.y = squaredAxis(-vector.x);
  }

  function releaseAxes(side: Side): void {
    if (side === "left") {
      state.throttle = null;
      state.strafeX = 0;
      return;
    }
    state.rotation.x = 0;
    state.rotation.y = 0;
  }

  function knobOffset(dxPx: number, dyPx: number): { x: number; y: number } {
    const length = Math.hypot(dxPx, dyPx);
    if (length <= stickRadiusPx || length === 0) {
      return { x: dxPx, y: dyPx };
    }
    return { x: (dxPx / length) * stickRadiusPx, y: (dyPx / length) * stickRadiusPx };
  }

  function zonePointerDown(side: Side, event: ReactPointerEvent<HTMLDivElement>): void {
    if (pointerBySide.current[side] !== null) {
      return;
    }
    tryCapturePointer(event.currentTarget, event.pointerId);
    pointerBySide.current[side] = event.pointerId;
    originBySide.current[side] = { x: event.clientX, y: event.clientY };
    state.pointers += 1;
    applyAxes(side, 0, 0);
    setSticks((current) => ({
      ...current,
      [side]: { originX: event.clientX, originY: event.clientY, knobX: 0, knobY: 0 },
    }));
  }

  function zonePointerMove(side: Side, event: ReactPointerEvent<HTMLDivElement>): void {
    if (pointerBySide.current[side] !== event.pointerId) {
      return;
    }
    const origin = originBySide.current[side];
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    applyAxes(side, dx, dy);
    const knob = knobOffset(dx, dy);
    setSticks((current) => ({
      ...current,
      [side]: { originX: origin.x, originY: origin.y, knobX: knob.x, knobY: knob.y },
    }));
  }

  function zonePointerEnd(side: Side, event: ReactPointerEvent<HTMLDivElement>): void {
    if (pointerBySide.current[side] !== event.pointerId) {
      return;
    }
    pointerBySide.current[side] = null;
    state.pointers = Math.max(0, state.pointers - 1);
    releaseAxes(side);
    setSticks((current) => ({ ...current, [side]: null }));
  }

  function holdStart(event: ReactPointerEvent<HTMLButtonElement>, apply: () => void): void {
    tryCapturePointer(event.currentTarget, event.pointerId);
    state.pointers += 1;
    apply();
  }

  function holdEnd(release: () => void): void {
    state.pointers = Math.max(0, state.pointers - 1);
    release();
  }

  function zone(side: Side): ReactNode {
    const visual = sticks[side];
    return (
      <div
        className={`touch-zone touch-zone-${side}`}
        data-testid={`touch-zone-${side}`}
        onPointerDown={(event) => zonePointerDown(side, event)}
        onPointerMove={(event) => zonePointerMove(side, event)}
        onPointerUp={(event) => zonePointerEnd(side, event)}
        onPointerCancel={(event) => zonePointerEnd(side, event)}
      >
        {visual === null ? (
          <div className={`touch-stick-hint touch-stick-hint-${side}`} aria-hidden="true">
            {side === "left" ? "THR" : "AIM"}
          </div>
        ) : (
          <div
            className="touch-stick"
            data-testid={`touch-stick-${side}`}
            style={{ left: visual.originX, top: visual.originY }}
          >
            <div
              className="touch-stick-knob"
              style={{ transform: `translate(${visual.knobX}px, ${visual.knobY}px)` }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="touch-controls" data-testid="touch-controls" data-view-mode={viewMode}>
      {viewMode === "first" ? (
        <>
          {zone("left")}
          {zone("right")}
        </>
      ) : null}
      <div className="touch-btn-col touch-btn-col-left" data-testid="touch-buttons-left">
        <button
          type="button"
          className="touch-btn"
          data-testid="touch-btn-scan"
          aria-label="Scan pulse"
          onClick={onScan}
        >
          <Radar size={20} />
        </button>
        <button
          type="button"
          className={`touch-btn ${flashlightOn ? "active" : ""}`}
          data-testid="touch-btn-flashlight"
          aria-label="Flashlight"
          onClick={onFlashlight}
        >
          <Flashlight size={20} />
        </button>
        <button
          type="button"
          className={`touch-btn ${viewMode === "third" ? "active" : ""}`}
          data-testid="touch-btn-camera"
          aria-label="Camera view"
          onClick={onCamera}
        >
          <Camera size={20} />
        </button>
        <div className="touch-btn-pair">
          <button
            type="button"
            className="touch-btn touch-btn-half"
            data-testid="touch-btn-roll-left"
            aria-label="Roll left (hold)"
            onPointerDown={(event) =>
              holdStart(event, () => {
                state.rotation.z = 1;
              })
            }
            onPointerUp={() =>
              holdEnd(() => {
                state.rotation.z = 0;
              })
            }
            onPointerCancel={() =>
              holdEnd(() => {
                state.rotation.z = 0;
              })
            }
          >
            <RotateCcw size={18} />
          </button>
          <button
            type="button"
            className="touch-btn touch-btn-half"
            data-testid="touch-btn-roll-right"
            aria-label="Roll right (hold)"
            onPointerDown={(event) =>
              holdStart(event, () => {
                state.rotation.z = -1;
              })
            }
            onPointerUp={() =>
              holdEnd(() => {
                state.rotation.z = 0;
              })
            }
            onPointerCancel={() =>
              holdEnd(() => {
                state.rotation.z = 0;
              })
            }
          >
            <RotateCw size={18} />
          </button>
        </div>
      </div>
      <div className="touch-btn-col touch-btn-col-right" data-testid="touch-buttons-right">
        <button
          type="button"
          className="touch-btn"
          data-testid="touch-btn-boost"
          aria-label="Boost"
          onClick={onBoost}
        >
          <Rocket size={20} />
        </button>
        <button
          type="button"
          className="touch-btn"
          data-testid="touch-btn-stabilize"
          aria-label="Stabilize (hold)"
          onPointerDown={(event) =>
            holdStart(event, () => {
              state.stabilize = true;
            })
          }
          onPointerUp={() =>
            holdEnd(() => {
              state.stabilize = false;
            })
          }
          onPointerCancel={() =>
            holdEnd(() => {
              state.stabilize = false;
            })
          }
        >
          <Crosshair size={20} />
        </button>
        <button
          type="button"
          className={`touch-btn ${cruiseLock ? "active" : ""}`}
          data-testid="touch-btn-cruise"
          aria-label="Cruise lock"
          onClick={onCruiseToggle}
        >
          <Gauge size={20} />
        </button>
        {/* Live stick value while held (this component re-renders on every stick move),
            falling back to the persistent HUD/cruise throttle. */}
        <div className="touch-throttle-readout" data-testid="touch-throttle-readout">
          {((state.throttle ?? throttle) * 100).toFixed(0)}%{cruiseLock ? " CRZ" : ""}
        </div>
      </div>
    </div>
  );
}
