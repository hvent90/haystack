// Froxel volumetric lighting — CPU EXECUTABLE SPEC (architecture §6, §2.5).
//
// This file is the f64 reference for the TSL froxel kernels in kernels/froxels.ts, in the
// same relationship binner-cpu.ts / collide-cpu.ts / cull-cpu.ts hold to their kernels:
// the bun tests (tests/integration/gpu-froxels.test.ts) pin THIS file's math, and the
// on-device gate (verify-gpu.ts) compares the GPU kernels against it on identical inputs.
//
// THE GRID (§2.5): view-space frustum-warped froxels, 160·90·64, index z*W*H + y*W + x.
// X/Y tile the NDC square; Z slices are LOG-DEPTH shells of RADIAL camera distance
// (length(viewPos), scene units) between FROXEL_NEAR and FROXEL_FAR. Radial distance —
// not view -z — because under the floating origin the apply node reconstructs
// length(viewPos) from depth exactly the way ScanPulse re-derives its basis (§5), and
// using one metric on both sides makes the depth-aware lookup exact by construction.
//
// THE MEDIUM: the baked belt density ([r][theta][z] polar uint8, shared/belt/format.ts)
// sampled trilinearly at the froxel center's world position -> extinction sigma_t. The
// froxel pass is COSMETIC (§ "determinism where it counts"): it never writes anything the
// physics/cull pipeline reads, and it tolerates f32/f64 drift (the gate uses epsilon, not
// byte equality).
//
// ACCUMULATOR SCHEMA (§2.5): froxelAccum vec4 = inScatter.rgb + transmittance.a.
//   scatter  : per-slice values  (slice in-scatter, slice transmittance)
//   integrate: front-to-back prefix over Z, IN PLACE — after it, accum[z] holds the
//              cumulative in-scatter and transmittance from the camera to the FAR EDGE
//              of slice z. The apply lookup at distance d interpolates fz = zOfDistance(d)-1
//              (identity (0,0,0,1) below the first slice's far edge).

// --- grid dimensions (§2.5 — committed schema) ---------------------------------------
export const FROXEL_W = 160;
export const FROXEL_H = 90;
export const FROXEL_D = 64;
export const FROXEL_COUNT = FROXEL_W * FROXEL_H * FROXEL_D; // 921,600

// Radial slice range in SCENE units (1 unit = 1 km). FAR sits inside the far-field
// handoff: the haze annulus fades in over 22..95 km (BeltFarField), the cull retires
// rocks at MAX_DRAW_SCENE = 18 — so the froxel medium owns 0..24 km and eases out over
// the last stretch (FROXEL_FADE_START) while the annulus/speckles keep the distance.
export const FROXEL_NEAR = 0.05;
export const FROXEL_FAR = 24;
export const FROXEL_FADE_START = 17;
export const FROXEL_LOG_RATIO = Math.log(FROXEL_FAR / FROXEL_NEAR);

export const METERS_PER_SCENE_UNIT = 1000;

export function froxelIndexOf(x: number, y: number, z: number): number {
  return z * FROXEL_W * FROXEL_H + y * FROXEL_W + x;
}

// Far edge of slice z (scene units): NEAR * (FAR/NEAR)^((z+1)/D). Slice 0 spans
// [NEAR, farEdge(0)); each slice is ~11.7% deeper than the previous (1200^(1/64)).
export function sliceFarEdge(z: number): number {
  return FROXEL_NEAR * Math.exp(((z + 1) / FROXEL_D) * FROXEL_LOG_RATIO);
}

// Continuous slice coordinate of a radial distance: zOfDistance(sliceFarEdge(z)) == z+1.
// The cumulative-accumulator lookup coordinate is zOfDistance(d) - 1 (so a fragment at
// exactly slice z's far edge reads accum[z] with weight 1).
export function zOfDistance(dist: number): number {
  return (FROXEL_D * Math.log(dist / FROXEL_NEAR)) / FROXEL_LOG_RATIO;
}

// --- the baked-density medium ---------------------------------------------------------

export type DensityGrid = {
  // [r][theta][z] C-order uint8 (shared/belt/format.ts BeltBake.density).
  data: Uint8Array;
  nr: number;
  ntheta: number;
  nz: number;
  rMin: number; // normalized sim units (× worldScale -> meters)
  rMax: number;
  zMax: number;
  worldScale: number; // meters per normalized unit (BELT_WORLD_SCALE = 1e6)
};

// Trilinear sample of the polar density grid at a WORLD position (meters), 0..1.
// Axis mapping matches the bake decode (format.ts): belt plane = world x–z, vertical =
// world y; theta = atan2(z, x) ∈ [-pi, pi) (the BeltFarField annulus UV convention).
// Theta wraps; r and z clamp, with a hard 0 outside [rMin,rMax] × [-zMax,zMax].
export function sampleDensity(g: DensityGrid, wx: number, wy: number, wz: number): number {
  const rNorm = Math.hypot(wx, wz) / g.worldScale;
  const zNorm = wy / g.worldScale;
  if (rNorm < g.rMin || rNorm > g.rMax || Math.abs(zNorm) > g.zMax) {
    return 0;
  }
  const theta = Math.atan2(wz, wx); // [-pi, pi)
  const fr = ((rNorm - g.rMin) / (g.rMax - g.rMin)) * g.nr - 0.5;
  const ft = ((theta + Math.PI) / (2 * Math.PI)) * g.ntheta - 0.5;
  const fz = ((zNorm + g.zMax) / (2 * g.zMax)) * g.nz - 0.5;

  const ir0 = Math.floor(fr);
  const it0 = Math.floor(ft);
  const iz0 = Math.floor(fz);
  const wr = fr - ir0;
  const wt = ft - it0;
  const wzf = fz - iz0;

  const clampR = (i: number): number => Math.min(g.nr - 1, Math.max(0, i));
  const wrapT = (i: number): number => ((i % g.ntheta) + g.ntheta) % g.ntheta;
  const clampZ = (i: number): number => Math.min(g.nz - 1, Math.max(0, i));

  let acc = 0;
  for (let dr = 0; dr <= 1; dr += 1) {
    for (let dt = 0; dt <= 1; dt += 1) {
      for (let dz = 0; dz <= 1; dz += 1) {
        const ir = clampR(ir0 + dr);
        const it = wrapT(it0 + dt);
        const iz = clampZ(iz0 + dz);
        const w = (dr === 0 ? 1 - wr : wr) * (dt === 0 ? 1 - wt : wt) * (dz === 0 ? 1 - wzf : wzf);
        acc += w * g.data[(ir * g.ntheta + it) * g.nz + iz]!;
      }
    }
  }
  return acc / 255;
}

// --- lighting (phase 2) ----------------------------------------------------------------
//
// Sun: the sun-occlusion.ts computeSunlit transmittance march, ported to run per FROXEL
// against the COLLISION world grid (§6.3) — product of (1 - cover) over up-sun rocks with
// a capped penumbra and a TRANS_FLOOR early-out. Same constants, different occluder
// source: the collision binner's cellStart/cellCount/sortedItems over the live `pos`
// buffer (so rocks the player actually sees cast the shafts). HALF-CELL stepping with a
// consecutive-cell dedupe visits every cell the ray passes through; unlike computeSunlit's
// 27-neighbour sweep, a rock whose center sits in a cell the ray never enters can still
// clip the penumbra cone and be missed — accepted soft under-shadowing at ~1/14th the
// bandwidth (921600 froxels × 27 cells × 14 steps would be GB/frame). Hero rocks near the
// ray — the visible shafts — are always in a visited cell.
export const SUN_ANGULAR_RADIUS = (0.5 * Math.PI) / 180; // ~1 degree disc (sun-occlusion.ts)
export const SUN_PENUMBRA_CAP = 120; // metres
export const SUN_TRANS_FLOOR = 0.002; // early-out once essentially fully shadowed
export const SUN_MARCH_STEP_METERS = 384; // half a 768 m collision cell
export const SUN_MARCH_STEPS = 14; // × 384 m ≈ 5.4 km (computeSunlit marched 5.65)

// Henyey-Greenstein phase: cosTheta between the light's propagation direction and the
// out-scattered (toward-camera) direction; forward peak at cosTheta = 1.
export function henyeyGreenstein(g: number, cosTheta: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(1 + g2 - 2 * g * cosTheta, 1.5));
}

function smoothstepf(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export type CollisionGridImage = {
  gridOrigin: { x: number; y: number; z: number }; // meters, ship-cell-snapped
  cellMeters: number; // 768
  gridAxis: number; // 64
  cellCount: Uint32Array; // per-cell occupancy (atomic image)
  cellStart: Uint32Array; // exclusive prefix
  sortedItems: Uint32Array; // item ids grouped by cell
  posXYZR: Float32Array; // the pos buffer image (xyz meters, w radius)
};

// Up-sun transmittance from a world point (METERS) through the collision grid. Mirrors
// the kernel exactly (incl. the consecutive-cell dedupe and the cover formula).
export function sunTransmittanceCPU(
  px: number,
  py: number,
  pz: number,
  sun: { x: number; y: number; z: number },
  grid: CollisionGridImage,
): number {
  const marchM = SUN_MARCH_STEPS * SUN_MARCH_STEP_METERS;
  const tanSun = Math.tan(SUN_ANGULAR_RADIUS);
  let trans = 1;
  let prevCell = -1;
  for (let i = 1; i <= SUN_MARCH_STEPS; i += 1) {
    const t = i * SUN_MARCH_STEP_METERS;
    const sx = px + sun.x * t;
    const sy = py + sun.y * t;
    const sz = pz + sun.z * t;
    const cx = Math.floor((sx - grid.gridOrigin.x) / grid.cellMeters);
    const cy = Math.floor((sy - grid.gridOrigin.y) / grid.cellMeters);
    const cz = Math.floor((sz - grid.gridOrigin.z) / grid.cellMeters);
    const a = grid.gridAxis;
    if (cx < 0 || cy < 0 || cz < 0 || cx >= a || cy >= a || cz >= a) {
      continue;
    }
    const cell = cx * a * a + cy * a + cz;
    if (cell === prevCell) {
      continue;
    }
    prevCell = cell;
    const start = grid.cellStart[cell]!;
    const occ = grid.cellCount[cell]!;
    for (let k = 0; k < occ; k += 1) {
      const j = grid.sortedItems[start + k]!;
      const qx = grid.posXYZR[j * 4]!;
      const qy = grid.posXYZR[j * 4 + 1]!;
      const qz = grid.posXYZR[j * 4 + 2]!;
      const qr = grid.posXYZR[j * 4 + 3]!;
      const wx = qx - px;
      const wy = qy - py;
      const wz = qz - pz;
      const along = wx * sun.x + wy * sun.y + wz * sun.z;
      if (along <= 0 || along > marchM) {
        continue;
      }
      const ex = wx - along * sun.x;
      const ey = wy - along * sun.y;
      const ez = wz - along * sun.z;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const penumbra = Math.min(SUN_PENUMBRA_CAP, along * tanSun);
      const cover = 1 - smoothstepf(qr, qr + penumbra, d);
      trans *= 1 - cover;
    }
    if (trans <= SUN_TRANS_FLOOR) {
      break;
    }
  }
  return trans;
}

export type FroxelLightParams = {
  // Unit direction TOWARD the sun (world == scene direction; the world group never
  // rotates), linear sun color, and the visual in-scatter gain.
  sunDirection: { x: number; y: number; z: number };
  sunColor: { x: number; y: number; z: number };
  sunStrength: number;
  hgG: number;
  // The collision world grid the shadow march reads; null = unshadowed sun.
  grid: CollisionGridImage | null;
  // Ship flashlight (analytic spot cone, SCENE units); null/intensity 0 = off.
  flash: {
    pos: { x: number; y: number; z: number }; // scene units
    dir: { x: number; y: number; z: number }; // unit forward
    color: { x: number; y: number; z: number };
    intensity: number; // flashlightIntensity × flashStrength tuning
    reach: number; // scene units
    cosInner: number;
    cosOuter: number;
    decay: number;
  } | null;
};

// --- scatter + integrate --------------------------------------------------------------

export type FroxelMediumParams = {
  // Column-major 4x4 matrices (THREE.Matrix4.elements layout).
  projectionMatrixInverse: ArrayLike<number>;
  cameraWorldMatrix: ArrayLike<number>;
  originMeters: { x: number; y: number; z: number };
  // Extinction per unit baked density (1/km at density 1.0) + a tiny uniform floor.
  sigmaScale: number;
  sigmaFloor: number;
  // Isotropic ambient in-scatter: albedo tint × strength.
  albedo: { x: number; y: number; z: number };
  ambient: number;
  // Phase-2 lights; omitted/null = ambient-only medium (the phase-1 behaviour).
  lights?: FroxelLightParams | null;
};

function applyMat4(
  e: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  w: number,
): [number, number, number, number] {
  return [
    e[0]! * x + e[4]! * y + e[8]! * z + e[12]! * w,
    e[1]! * x + e[5]! * y + e[9]! * z + e[13]! * w,
    e[2]! * x + e[6]! * y + e[10]! * z + e[14]! * w,
    e[3]! * x + e[7]! * y + e[11]! * z + e[15]! * w,
  ];
}

// The world-space center of froxel (x, y, z) in METERS, under the floating origin
// (§ "floating origin" hard constraint): NDC tile center -> view ray via projInv ->
// radial slice-center distance -> scene space via the camera world matrix ->
// originMeters + scene·1000. Mirrored verbatim by the kernel.
export function froxelCenterWorldMeters(
  x: number,
  y: number,
  z: number,
  p: Pick<FroxelMediumParams, "projectionMatrixInverse" | "cameraWorldMatrix" | "originMeters">,
): {
  x: number;
  y: number;
  z: number;
  dist: number;
  sceneX: number;
  sceneY: number;
  sceneZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
} {
  const ndcX = ((x + 0.5) / FROXEL_W) * 2 - 1;
  const ndcY = ((y + 0.5) / FROXEL_H) * 2 - 1;
  const [vx, vy, vz, vw] = applyMat4(p.projectionMatrixInverse, ndcX, ndcY, 0.5, 1);
  const ix = vx / vw;
  const iy = vy / vw;
  const iz = vz / vw;
  const inv = 1 / Math.hypot(ix, iy, iz);
  // Slice CENTER in log space: geometric mean of the slice's near/far edges.
  const dist = FROXEL_NEAR * Math.exp(((z + 0.5) / FROXEL_D) * FROXEL_LOG_RATIO);
  const [sx, sy, sz] = applyMat4(
    p.cameraWorldMatrix,
    ix * inv * dist,
    iy * inv * dist,
    iz * inv * dist,
    1,
  );
  return {
    x: p.originMeters.x + sx * METERS_PER_SCENE_UNIT,
    y: p.originMeters.y + sy * METERS_PER_SCENE_UNIT,
    z: p.originMeters.z + sz * METERS_PER_SCENE_UNIT,
    dist,
    // Scene-space position + unit view direction (camera -> froxel; world == scene
    // direction since the world group never rotates) — the lighting terms' frame.
    sceneX: sx,
    sceneY: sy,
    sceneZ: sz,
    dirX: (sx - p.cameraWorldMatrix[12]!) / dist,
    dirY: (sy - p.cameraWorldMatrix[13]!) / dist,
    dirZ: (sz - p.cameraWorldMatrix[14]!) / dist,
  };
}

// Per-slice extinction sigma_t (1/km) at a froxel: baked density × scale + floor, eased
// out over the far handoff band so the medium never ends on a hard shell.
export function froxelSigmaT(
  density01: number,
  dist: number,
  sigmaScale: number,
  sigmaFloor: number,
): number {
  const t = Math.min(1, Math.max(0, (dist - FROXEL_FADE_START) / (FROXEL_FAR - FROXEL_FADE_START)));
  const fade = 1 - t * t * (3 - 2 * t);
  return (density01 * sigmaScale + sigmaFloor) * fade;
}

// scatter: per-slice (inScatter.rgb, transmittance.a) for every froxel, into `out`
// (FROXEL_COUNT*4 floats). In-scatter = albedo · (ambient + sun + flashlight) · (1 - Ts):
// the sun term carries the up-sun rock-shadow march and an HG phase on dot(S, viewDir);
// the flashlight is an analytic spot cone with range/decay falloff and the same phase
// (light propagation vs toward-camera). Lights skip where sigma_t ≈ 0 (nothing scatters).
export function froxelScatterCPU(
  g: DensityGrid | null,
  p: FroxelMediumParams,
  out: Float32Array,
): void {
  const lights = p.lights ?? null;
  for (let z = 0; z < FROXEL_D; z += 1) {
    const sliceLen = sliceFarEdge(z) - (z === 0 ? FROXEL_NEAR : sliceFarEdge(z - 1));
    for (let y = 0; y < FROXEL_H; y += 1) {
      for (let x = 0; x < FROXEL_W; x += 1) {
        const c = froxelCenterWorldMeters(x, y, z, p);
        const d = g === null ? 0 : sampleDensity(g, c.x, c.y, c.z);
        const sigmaT = froxelSigmaT(d, c.dist, p.sigmaScale, p.sigmaFloor);
        const trans = Math.exp(-sigmaT * sliceLen);
        let lr = p.ambient;
        let lg = p.ambient;
        let lb = p.ambient;
        if (lights !== null && sigmaT > 1e-4) {
          const s = lights.sunDirection;
          if (lights.sunStrength > 0) {
            const sunT =
              lights.grid === null ? 1 : sunTransmittanceCPU(c.x, c.y, c.z, s, lights.grid);
            const phase = henyeyGreenstein(lights.hgG, s.x * c.dirX + s.y * c.dirY + s.z * c.dirZ);
            const e = lights.sunStrength * phase * sunT;
            lr += lights.sunColor.x * e;
            lg += lights.sunColor.y * e;
            lb += lights.sunColor.z * e;
          }
          const f = lights.flash;
          if (f !== null && f.intensity > 0) {
            const tx = c.sceneX - f.pos.x;
            const ty = c.sceneY - f.pos.y;
            const tz = c.sceneZ - f.pos.z;
            const df = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (df > 1e-4 && df < f.reach) {
              const lx = tx / df;
              const ly = ty / df;
              const lz = tz / df;
              const spot = smoothstepf(
                f.cosOuter,
                f.cosInner,
                lx * f.dir.x + ly * f.dir.y + lz * f.dir.z,
              );
              const range = (1 - df / f.reach) ** 2;
              const atten = range / Math.max(Math.pow(df, f.decay), 0.05);
              const phase = henyeyGreenstein(
                lights.hgG,
                -(lx * c.dirX + ly * c.dirY + lz * c.dirZ),
              );
              const e = f.intensity * spot * atten * phase;
              lr += f.color.x * e;
              lg += f.color.y * e;
              lb += f.color.z * e;
            }
          }
        }
        const energy = 1 - trans;
        const o = froxelIndexOf(x, y, z) * 4;
        out[o] = p.albedo.x * lr * energy;
        out[o + 1] = p.albedo.y * lg * energy;
        out[o + 2] = p.albedo.z * lb * energy;
        out[o + 3] = trans;
      }
    }
  }
}

// integrate: IN-PLACE front-to-back prefix over Z (one pass per X/Y column):
//   L += T_acc * slice.rgb ;  T_acc *= slice.a ;  accum[z] = (L, T_acc)
export function froxelIntegrateCPU(accum: Float32Array): void {
  for (let y = 0; y < FROXEL_H; y += 1) {
    for (let x = 0; x < FROXEL_W; x += 1) {
      let lr = 0;
      let lg = 0;
      let lb = 0;
      let t = 1;
      for (let z = 0; z < FROXEL_D; z += 1) {
        const o = froxelIndexOf(x, y, z) * 4;
        lr += t * accum[o]!;
        lg += t * accum[o + 1]!;
        lb += t * accum[o + 2]!;
        t *= accum[o + 3]!;
        accum[o] = lr;
        accum[o + 1] = lg;
        accum[o + 2] = lb;
        accum[o + 3] = t;
      }
    }
  }
}
