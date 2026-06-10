// Shared state + pure stick math for the touch flight controls.
//
// TouchFlightControls' pointer handlers mutate one TouchFlightState object; EveApp's
// buildFlightInput reads it on the 60Hz input timer — the same ref seam the keyboard
// (heldKeysRef) and mouse (mouseDeflectionRef) paths use. Touch therefore produces the
// exact same FlightInputCommand stream as desktop input: prediction and the server
// never know the input came from a thumb.

export type TouchFlightState = {
  /** Left stick vertical, [-1, 1]; null while the stick is released so the persistent
      HUD/cruise throttle applies — exactly like releasing W/S on desktop. */
  throttle: number | null;
  /** Left stick horizontal: lateral strafe, [-1, 1]. */
  strafeX: number;
  /** Right stick (x = pitch, y = yaw, squared response) + roll hold-buttons (z). */
  rotation: { x: number; y: number; z: number };
  /** Stabilize hold-button — rides on every command while held, like KeyX. */
  stabilize: boolean;
  /** Count of active flight touches (sticks + hold buttons). >0 means the input timer
      runs `active` commands, playing the role pointer lock plays on desktop. */
  pointers: number;
};

export function createTouchFlightState(): TouchFlightState {
  return {
    throttle: null,
    strafeX: 0,
    rotation: { x: 0, y: 0, z: 0 },
    stabilize: false,
    pointers: 0,
  };
}

export function touchFlightEngaged(state: TouchFlightState): boolean {
  return state.pointers > 0;
}

/** Reset the analog values (blur / unmount). Deliberately leaves `pointers` alone —
    lifted fingers decrement it through their own pointerup/cancel handlers. */
export function resetTouchFlightAxes(state: TouchFlightState): void {
  state.throttle = null;
  state.strafeX = 0;
  state.rotation.x = 0;
  state.rotation.y = 0;
  state.rotation.z = 0;
  state.stabilize = false;
}

/** Max thumb travel from the spawn point that maps to full deflection. */
export const stickRadiusPx = 60;
/** Fraction of the radius ignored around center so a resting thumb reads as zero. */
export const stickDeadzone = 0.12;

/**
 * Raw thumb offset (px from where the stick spawned) -> stick vector with magnitude in
 * [0, 1]. Clamped to the radius circle; the deadzone is carved out radially and the
 * remaining band re-normalized, so output grows continuously from 0 at the deadzone
 * edge to 1 at full deflection (no jump when leaving the deadzone).
 */
export function stickVector(
  dxPx: number,
  dyPx: number,
  radiusPx: number = stickRadiusPx,
  deadzone: number = stickDeadzone,
): { x: number; y: number } {
  const lengthPx = Math.hypot(dxPx, dyPx);
  if (lengthPx === 0) {
    return { x: 0, y: 0 };
  }
  const raw = Math.min(1, lengthPx / radiusPx);
  const magnitude = raw <= deadzone ? 0 : (raw - deadzone) / (1 - deadzone);
  return { x: (dxPx / lengthPx) * magnitude, y: (dyPx / lengthPx) * magnitude };
}

/**
 * Sign-preserving square. A linear stick -> rotation-rate map is too twitchy to aim
 * with (the first few degrees of thumb travel already command a fast turn); squaring
 * keeps the center half of the stick gentle while the edge still reaches full rate.
 */
export function squaredAxis(value: number): number {
  return Math.sign(value) * value * value;
}
