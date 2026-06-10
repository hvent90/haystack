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

// --- scatter + integrate --------------------------------------------------------------

export type FroxelMediumParams = {
  // Column-major 4x4 matrices (THREE.Matrix4.elements layout).
  projectionMatrixInverse: ArrayLike<number>;
  cameraWorldMatrix: ArrayLike<number>;
  originMeters: { x: number; y: number; z: number };
  // Extinction per unit baked density (1/km at density 1.0) + a tiny uniform floor.
  sigmaScale: number;
  sigmaFloor: number;
  // Phase-1 ambient in-scatter: albedo tint × strength. (Lights land in phase 2.)
  albedo: { x: number; y: number; z: number };
  ambient: number;
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
): { x: number; y: number; z: number; dist: number } {
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
// (FROXEL_COUNT*4 floats). Phase 1: ambient-lit medium only.
export function froxelScatterCPU(
  g: DensityGrid | null,
  p: FroxelMediumParams,
  out: Float32Array,
): void {
  for (let z = 0; z < FROXEL_D; z += 1) {
    const sliceLen = sliceFarEdge(z) - (z === 0 ? FROXEL_NEAR : sliceFarEdge(z - 1));
    for (let y = 0; y < FROXEL_H; y += 1) {
      for (let x = 0; x < FROXEL_W; x += 1) {
        const c = froxelCenterWorldMeters(x, y, z, p);
        const d = g === null ? 0 : sampleDensity(g, c.x, c.y, c.z);
        const sigmaT = froxelSigmaT(d, c.dist, p.sigmaScale, p.sigmaFloor);
        const trans = Math.exp(-sigmaT * sliceLen);
        const energy = p.ambient * (1 - trans);
        const o = froxelIndexOf(x, y, z) * 4;
        out[o] = p.albedo.x * energy;
        out[o + 1] = p.albedo.y * energy;
        out[o + 2] = p.albedo.z * energy;
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
