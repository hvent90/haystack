import { getRenderDebugControls } from "./render-stats";
import { Quaternion as ThreeQuaternion, Vector3 as ThreeVector3 } from "three";

import type { Quaternion, Ship, Vector3 } from "../../shared/types";

// How quickly an owned-ship reconciliation correction is blended out. A larger
// value is smoother but lets the visible position lag the truth longer. ~80ms
// feels responsive while removing the hard snap.
const ownedErrorTauSec = 0.12;

// Owned prediction arrives on a ~60Hz input timer that is not phase-locked to
// the animation frames. Between predicts we dead-reckon the rendered position by
// the last predicted velocity so the camera advances every frame instead of
// stepping at the timer cadence. Capped so the render never runs too far ahead
// when predicts stop arriving.
const maxOwnedExtrapolationSec = 0.05;

// Render remote entities this far in the past so there are always two buffered
// snapshots bracketing the render time to interpolate between. ~2-3 broadcast
// periods at 30Hz.
const interpolationDelayMs = 90;

// Resync the interpolation clock instead of easing if it drifts further than
// this from the target (tab was backgrounded, large stall, etc.).
const clockResyncThresholdMs = 400;

const maxBufferedSamples = 32;

type RemoteSample = {
  t: number;
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
};

export type RemoteTransform = {
  position: Vector3;
  orientation: Quaternion;
};

/**
 * Holds render-ready transforms decoupled from React state so the 3D scene can
 * advance every animation frame in useFrame rather than only on network/React
 * commits. Owned-ship reconciliation corrections are absorbed into a decaying
 * error offset (no hard snap); remote ships are interpolated between buffered
 * authoritative snapshots on a server-time clock.
 */
export class FlightRenderStore {
  private readonly predPos = new ThreeVector3();
  private readonly predVel = new ThreeVector3();
  private readonly predQuat = new ThreeQuaternion(0, 0, 0, 1);
  private readonly errPos = new ThreeVector3();
  private readonly errQuat = new ThreeQuaternion(0, 0, 0, 1);
  private extrapolationSec = 0;
  private owned = false;

  private readonly remote = new Map<string, RemoteSample[]>();
  private renderClockMs = 0;
  private latestServerMs = 0;
  private clockInitialized = false;

  // Reused scratch / output objects to avoid per-frame allocation.
  private readonly scratchVec = new ThreeVector3();
  private readonly scratchQuat = new ThreeQuaternion();
  private readonly scratchQuat2 = new ThreeQuaternion();
  private readonly identityQuat = new ThreeQuaternion(0, 0, 0, 1);
  private readonly outPos: Vector3 = { x: 0, y: 0, z: 0 };
  private readonly outQuat: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
  private readonly outTransform: RemoteTransform = {
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  };

  hasOwned(): boolean {
    return this.owned;
  }

  /** Hard reset (initial seed / pilot change / teleport): snap with no blend. */
  resetOwned(ship: Ship): void {
    this.predPos.set(ship.position.x, ship.position.y, ship.position.z);
    this.predVel.set(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    this.predQuat
      .set(ship.orientation.x, ship.orientation.y, ship.orientation.z, ship.orientation.w)
      .normalize();
    this.errPos.set(0, 0, 0);
    this.errQuat.set(0, 0, 0, 1);
    this.extrapolationSec = 0;
    this.owned = true;
  }

  /** Normal prediction advance. Continuity-preserving (see applyOwned). */
  setOwnedPredicted(ship: Ship): void {
    this.applyOwned(ship);
  }

  /** Reconcile correction. Continuity-preserving (see applyOwned). */
  correctOwned(ship: Ship): void {
    this.applyOwned(ship);
  }

  /**
   * Adopt a new authoritative owned state (from prediction or reconciliation)
   * without a visible jump: fold the delta between the currently rendered
   * transform and the new state into the error offset, which then decays toward
   * zero. Normal small per-tick advances produce ~zero error; a reconcile snap
   * produces a large error that blends out smoothly.
   */
  private applyOwned(ship: Ship): void {
    if (!this.owned) {
      this.resetOwned(ship);
      return;
    }
    const renderPos = this.ownedRenderVector();
    const renderQuat = this.ownedRenderQuat();

    this.predPos.set(ship.position.x, ship.position.y, ship.position.z);
    this.predVel.set(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    this.predQuat
      .set(ship.orientation.x, ship.orientation.y, ship.orientation.z, ship.orientation.w)
      .normalize();
    this.extrapolationSec = 0;

    // errPos = renderPos - predPos  => render stays at renderPos this frame.
    this.errPos.copy(renderPos).sub(this.predPos);
    // errQuat = renderQuat * predQuat^-1
    this.scratchQuat.copy(this.predQuat).invert();
    this.errQuat.copy(renderQuat).multiply(this.scratchQuat).normalize();
  }

  /** Decay the owned-ship error toward zero and advance the interpolation clock. */
  advance(dtSec: number): void {
    if (dtSec <= 0) {
      return;
    }
    this.extrapolationSec += dtSec;
    const decay = Math.exp(-dtSec / ownedErrorTauSec);
    this.errPos.multiplyScalar(decay);
    this.errQuat.slerp(this.identityQuat, 1 - decay).normalize();

    if (this.clockInitialized) {
      this.renderClockMs += dtSec * 1000;
      const target = this.latestServerMs - interpolationDelayMs;
      const drift = target - this.renderClockMs;
      if (Math.abs(drift) > clockResyncThresholdMs) {
        this.renderClockMs = target;
      } else {
        this.renderClockMs += drift * Math.min(1, dtSec * 4);
      }
      if (this.renderClockMs > this.latestServerMs) {
        this.renderClockMs = this.latestServerMs;
      }
    }
  }

  // predPos + predVel * clampedExtrapolation + errPos, written into scratchVec.
  private ownedRenderVector(): ThreeVector3 {
    const t = Math.min(this.extrapolationSec, maxOwnedExtrapolationSec);
    return this.scratchVec.copy(this.predVel).multiplyScalar(t).add(this.predPos).add(this.errPos);
  }

  // errQuat * predQuat, written into scratchQuat2.
  private ownedRenderQuat(): ThreeQuaternion {
    return this.scratchQuat2.copy(this.errQuat).multiply(this.predQuat).normalize();
  }

  ownedRenderPosition(): Vector3 {
    // Capture-only viewpoint override (render-stats debug controls): the camera origin
    // snaps to the override so capture scripts can frame the belt at any scale.
    const viewPos = getRenderDebugControls().viewPos;
    if (viewPos !== null) {
      this.outPos.x = viewPos.x;
      this.outPos.y = viewPos.y;
      this.outPos.z = viewPos.z;
      return this.outPos;
    }
    const vector = this.ownedRenderVector();
    this.outPos.x = vector.x;
    this.outPos.y = vector.y;
    this.outPos.z = vector.z;
    return this.outPos;
  }

  ownedRenderQuaternion(): Quaternion {
    const quat = this.ownedRenderQuat();
    this.outQuat.x = quat.x;
    this.outQuat.y = quat.y;
    this.outQuat.z = quat.z;
    this.outQuat.w = quat.w;
    return this.outQuat;
  }

  pushRemote(
    pilotId: string,
    serverTimeMs: number,
    position: Vector3,
    orientation: Quaternion,
  ): void {
    let buffer = this.remote.get(pilotId);
    if (buffer === undefined) {
      buffer = [];
      this.remote.set(pilotId, buffer);
    }
    const last = buffer[buffer.length - 1];
    if (last !== undefined && serverTimeMs <= last.t) {
      return; // out-of-order or duplicate
    }
    buffer.push({
      t: serverTimeMs,
      px: position.x,
      py: position.y,
      pz: position.z,
      qx: orientation.x,
      qy: orientation.y,
      qz: orientation.z,
      qw: orientation.w,
    });
    if (buffer.length > maxBufferedSamples) {
      buffer.splice(0, buffer.length - maxBufferedSamples);
    }
    if (serverTimeMs > this.latestServerMs) {
      this.latestServerMs = serverTimeMs;
    }
    if (!this.clockInitialized) {
      this.renderClockMs = serverTimeMs - interpolationDelayMs;
      this.clockInitialized = true;
    }
  }

  removeRemote(pilotId: string): void {
    this.remote.delete(pilotId);
  }

  /** Live sample at the current interpolation clock (used in the render loop). */
  sampleRemote(pilotId: string): RemoteTransform | null {
    return this.sampleRemoteAt(pilotId, this.renderClockMs);
  }

  /** Sample a remote pilot's interpolated transform at an explicit server time. */
  sampleRemoteAt(pilotId: string, serverTimeMs: number): RemoteTransform | null {
    const buffer = this.remote.get(pilotId);
    if (buffer === undefined || buffer.length === 0) {
      return null;
    }
    const first = buffer[0]!;
    if (buffer.length === 1 || serverTimeMs <= first.t) {
      return this.writeTransform(first, first, 0);
    }
    const last = buffer[buffer.length - 1]!;
    if (serverTimeMs >= last.t) {
      return this.writeTransform(last, last, 0);
    }
    for (let i = 1; i < buffer.length; i += 1) {
      const after = buffer[i]!;
      if (serverTimeMs <= after.t) {
        const before = buffer[i - 1]!;
        const span = after.t - before.t;
        const fraction = span <= 0 ? 0 : (serverTimeMs - before.t) / span;
        return this.writeTransform(before, after, fraction);
      }
    }
    return this.writeTransform(last, last, 0);
  }

  private writeTransform(
    before: RemoteSample,
    after: RemoteSample,
    fraction: number,
  ): RemoteTransform {
    const position = this.outTransform.position;
    position.x = before.px + (after.px - before.px) * fraction;
    position.y = before.py + (after.py - before.py) * fraction;
    position.z = before.pz + (after.pz - before.pz) * fraction;

    this.scratchQuat.set(before.qx, before.qy, before.qz, before.qw);
    if (fraction > 0) {
      this.scratchQuat2.set(after.qx, after.qy, after.qz, after.qw);
      this.scratchQuat.slerp(this.scratchQuat2, fraction);
    }
    const orientation = this.outTransform.orientation;
    orientation.x = this.scratchQuat.x;
    orientation.y = this.scratchQuat.y;
    orientation.z = this.scratchQuat.z;
    orientation.w = this.scratchQuat.w;
    return this.outTransform;
  }
}

// One owned pilot per client tab.
export const flightRenderStore = new FlightRenderStore();
