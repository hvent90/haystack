import { describe, expect, test } from "bun:test";

import { FlightRenderStore } from "../../src/client/eve/renderStore";
import type { Quaternion, Ship, Vector3 } from "../../src/shared/types";

function shipAt(position: Vector3, orientation: Quaternion = { x: 0, y: 0, z: 0, w: 1 }): Ship {
  return {
    pilotId: "owned",
    name: "Owned",
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    throttle: 0,
    cruiseLock: false,
    navLightsOn: false,
    flashlightOn: false,
    heat: 0,
    cargoMass: 0,
    cargoCapacity: 100,
    scanPower: 1,
    miningPower: 1,
    stabilizerEfficiency: 0.4,
  };
}

function shipAtWithVelocity(position: Vector3, velocity: Vector3): Ship {
  return { ...shipAt(position), velocity };
}

describe("owned render smoothing", () => {
  test("resetOwned snaps the rendered transform to the ship position", () => {
    const store = new FlightRenderStore();
    store.resetOwned(shipAt({ x: 10, y: 0, z: -4 }));

    const render = store.ownedRenderPosition();
    expect(render.x).toBeCloseTo(10, 6);
    expect(render.z).toBeCloseTo(-4, 6);
  });

  test("dead-reckons the owned position by velocity between predicts", () => {
    const store = new FlightRenderStore();
    store.resetOwned(shipAtWithVelocity({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 }));

    // No new prediction arrives, but the render loop keeps ticking; the rendered
    // position must keep moving (extrapolated) instead of stalling.
    store.advance(0.05);
    const render = store.ownedRenderPosition();
    expect(render.z).toBeCloseTo(-0.5, 2); // 10 m/s * 0.05 s
  });

  test("adopting a new authoritative state is continuous, then converges", () => {
    const store = new FlightRenderStore();
    store.resetOwned(shipAt({ x: 0, y: 0, z: 0 }));
    const before = store.ownedRenderPosition().z;

    // A correction 5m ahead must NOT snap the rendered position this frame.
    store.correctOwned(shipAt({ x: 0, y: 0, z: -5 }));
    const immediate = store.ownedRenderPosition();
    expect(immediate.z).toBeCloseTo(before, 3);

    for (let i = 0; i < 200; i += 1) {
      store.advance(1 / 60);
    }
    const settled = store.ownedRenderPosition();
    expect(settled.z).toBeCloseTo(-5, 2);
  });

  test("orientation corrections are blended continuously, not snapped", () => {
    const store = new FlightRenderStore();
    store.resetOwned(shipAt({ x: 0, y: 0, z: 0 }));
    const yaw = Math.SQRT1_2;
    store.correctOwned(shipAt({ x: 0, y: 0, z: 0 }, { x: 0, y: yaw, z: 0, w: yaw }));
    const immediate = store.ownedRenderQuaternion();
    expect(Math.abs(immediate.w)).toBeCloseTo(1, 2); // still ~identity this frame

    for (let i = 0; i < 200; i += 1) {
      store.advance(1 / 60);
    }
    const settled = store.ownedRenderQuaternion();
    expect(Math.abs(settled.y)).toBeCloseTo(yaw, 2);
  });
});

describe("remote snapshot interpolation", () => {
  test("interpolates between the two snapshots bracketing the render time", () => {
    const store = new FlightRenderStore();
    store.pushRemote("rival", 100, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    store.pushRemote("rival", 200, { x: 10, y: 0, z: -20 }, { x: 0, y: 0, z: 0, w: 1 });

    const mid = store.sampleRemoteAt("rival", 150);
    expect(mid).not.toBeNull();
    expect(mid!.position.x).toBeCloseTo(5, 3);
    expect(mid!.position.z).toBeCloseTo(-10, 3);
  });

  test("clamps to the endpoints outside the buffered range", () => {
    const store = new FlightRenderStore();
    store.pushRemote("rival", 100, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    store.pushRemote("rival", 200, { x: 9, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });

    expect(store.sampleRemoteAt("rival", 50)!.position.x).toBeCloseTo(1, 3);
    expect(store.sampleRemoteAt("rival", 999)!.position.x).toBeCloseTo(9, 3);
  });

  test("ignores out-of-order and duplicate samples", () => {
    const store = new FlightRenderStore();
    store.pushRemote("rival", 200, { x: 9, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    store.pushRemote("rival", 100, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }); // stale
    store.pushRemote("rival", 200, { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }); // dup tick

    expect(store.sampleRemoteAt("rival", 200)!.position.x).toBeCloseTo(9, 3);
  });

  test("returns null for unknown pilots and after removal", () => {
    const store = new FlightRenderStore();
    expect(store.sampleRemoteAt("ghost", 100)).toBeNull();
    store.pushRemote("rival", 100, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    store.removeRemote("rival");
    expect(store.sampleRemoteAt("rival", 100)).toBeNull();
  });
});
