"""N-body belt simulation (Phase 1 of the pipeline).

Physics model
-------------
A gas giant (mass 1, G = 1) + 2..4 massive moons integrated with WHFast
(symplectic), plus N massless test particles forming the belt. Moons carve
resonance gaps (Kirkwood-style) and shepherd edges; ~`families.count`
parent-breakup events inject debris clouds with correlated velocities at
staggered times, so young families are tight clumps and old ones have sheared
into arcs/rings by the final epoch.

Gap clearing is dynamically honest: a particle is removed only when its orbit
has *evolved* into a removal condition — eccentricity pumped past `e_max`, a
moon-orbit crossing within ~2.5 Hill radii (WHFast cannot resolve the close
encounter that would scatter it; we remove instead), or leaving `r_bounds`.
There is no a-priori carving of resonance zones.

Parallelism
-----------
Test particles do not interact, so the particle set is sharded across
processes. Every shard integrates the identical massive-body system (same
initial conditions, same event timeline, massless test particles cannot
perturb it), so shard outputs concatenate into one consistent belt. Family
events are partitioned across shards; ids stay globally unique.
"""

from __future__ import annotations

import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rebound

from .config import Preset, load_preset, run_dir_for
from .elements import elements

TWO_PI = 2.0 * np.pi


# ---------------------------------------------------------------------------
# Vectorized element -> cartesian initial conditions
# ---------------------------------------------------------------------------


def _solve_kepler(M: np.ndarray, e: np.ndarray, iters: int = 12) -> np.ndarray:
    """Eccentric anomaly via vectorized Newton iteration (e < 0.9 here)."""
    E = M + e * np.sin(M)
    for _ in range(iters):
        f = E - e * np.sin(E) - M
        fp = 1.0 - e * np.cos(E)
        E = E - f / fp
    return E


def elements_to_cartesian(
    a: np.ndarray,
    e: np.ndarray,
    inc: np.ndarray,
    Omega: np.ndarray,
    omega: np.ndarray,
    M: np.ndarray,
    mu: float = 1.0,
) -> tuple[np.ndarray, np.ndarray]:
    E = _solve_kepler(M, e)
    cosE, sinE = np.cos(E), np.sin(E)
    # Perifocal coordinates.
    xp = a * (cosE - e)
    yp = a * np.sqrt(1.0 - e * e) * sinE
    r = a * (1.0 - e * cosE)
    vscale = np.sqrt(mu * a) / r
    vxp = -vscale * sinE
    vyp = vscale * np.sqrt(1.0 - e * e) * cosE

    cO, sO = np.cos(Omega), np.sin(Omega)
    co, so = np.cos(omega), np.sin(omega)
    ci, si = np.cos(inc), np.sin(inc)
    # Rotation perifocal -> inertial (Rz(Omega) Rx(inc) Rz(omega)).
    r11 = cO * co - sO * so * ci
    r12 = -cO * so - sO * co * ci
    r21 = sO * co + cO * so * ci
    r22 = -sO * so + cO * co * ci
    r31 = so * si
    r32 = co * si

    pos = np.stack([r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp], axis=1)
    vel = np.stack([r11 * vxp + r12 * vyp, r21 * vxp + r22 * vyp, r31 * vxp + r32 * vyp], axis=1)
    return pos, vel


# ---------------------------------------------------------------------------
# Shard simulation
# ---------------------------------------------------------------------------


@dataclass
class ShardResult:
    pos: np.ndarray  # (N, 3) planet-centric, float64
    vel: np.ndarray
    family: np.ndarray  # (N,) int32, -1 = background
    n_removed: int


def _build_sim(preset: Preset) -> rebound.Simulation:
    sim = rebound.Simulation()
    sim.integrator = "whfast"
    sim.add(m=1.0)  # the gas giant
    for moon in preset.moons:
        sim.add(m=moon.mass, a=moon.a, e=moon.e, inc=moon.inc, primary=sim.particles[0])
    sim.N_active = 1 + len(preset.moons)
    shortest = min(m.a for m in preset.moons) ** 1.5 * TWO_PI
    sim.dt = preset.integration.dt_fraction * shortest
    # REBOUND 5 API: whfast knobs live on sim.integrator; add/remove auto-flag
    # Jacobi-coordinate recalculation.
    sim.integrator.safe_mode = 0
    return sim


def _state_arrays(sim: rebound.Simulation) -> tuple[np.ndarray, np.ndarray]:
    n = sim.N
    xyz = np.zeros((n, 3), dtype=np.float64)
    vxvyvz = np.zeros((n, 3), dtype=np.float64)
    sim.serialize_particle_data(xyz=xyz, vxvyvz=vxvyvz)
    return xyz, vxvyvz


def _moon_bands(preset: Preset) -> list[tuple[float, float]]:
    """(a_moon, half-width) removal bands: crossings within ~2.5 Hill radii."""
    bands = []
    for moon in preset.moons:
        r_hill = moon.a * (moon.mass / 3.0) ** (1.0 / 3.0)
        bands.append((moon.a, 2.5 * r_hill))
    return bands


def simulate_shard(preset: Preset, shard: int, n_shards: int) -> ShardResult:
    rng = np.random.default_rng([preset.seed, shard])
    integ = preset.integration
    belt = preset.belt
    t_end = integ.n_orbits * TWO_PI

    # --- shard's slice of the particle budget -------------------------------
    n_total = belt.n_particles
    n_fam_total = int(round(n_total * preset.families.particle_fraction))
    n_bg_total = n_total - n_fam_total
    n_bg = n_bg_total // n_shards + (1 if shard < n_bg_total % n_shards else 0)

    # Family events are partitioned round-robin; sizes drawn from a lognormal
    # so families vary in richness like real ones. The size draw uses the
    # PRESET seed (not the shard) so every shard agrees on the partition.
    fam_rng = np.random.default_rng([preset.seed, 999_983])
    fam_count = preset.families.count
    weights = fam_rng.lognormal(0.0, 0.8, fam_count)
    fam_sizes = np.maximum(4, np.round(n_fam_total * weights / weights.sum()).astype(int))
    lo, hi = preset.families.inject_window
    fam_times = np.sort(fam_rng.uniform(lo * t_end, hi * t_end, fam_count))
    fam_dv = fam_rng.uniform(
        preset.families.dv_over_vorb_min, preset.families.dv_over_vorb_max, fam_count
    )
    shard_fams = [i for i in range(fam_count) if i % n_shards == shard]

    # --- initial belt -------------------------------------------------------
    sim = _build_sim(preset)
    n_active = sim.N_active
    a0 = rng.uniform(belt.a_min, belt.a_max, n_bg)
    e0 = np.clip(rng.rayleigh(belt.e_sigma, n_bg), 0.0, 0.6)
    i0 = rng.rayleigh(belt.inc_sigma, n_bg)
    ang = rng.uniform(0.0, TWO_PI, (n_bg, 3))
    pos0, vel0 = elements_to_cartesian(a0, e0, i0, ang[:, 0], ang[:, 1], ang[:, 2])
    planet = sim.particles[0]
    for k in range(n_bg):
        sim.add(
            x=pos0[k, 0] + planet.x,
            y=pos0[k, 1] + planet.y,
            z=pos0[k, 2] + planet.z,
            vx=vel0[k, 0] + planet.vx,
            vy=vel0[k, 1] + planet.vy,
            vz=vel0[k, 2] + planet.vz,
        )
    sim.move_to_com()

    family = np.full(n_bg, -1, dtype=np.int32)
    n_removed = 0

    # --- event timeline: culls + this shard's family injections -------------
    cull_dt = integ.cull_every_orbits * TWO_PI
    events: list[tuple[float, str, int]] = [(fam_times[i], "inject", i) for i in shard_fams]
    events += [(k * cull_dt, "cull", -1) for k in range(1, int(t_end / cull_dt) + 1)]
    events.append((t_end, "end", -1))
    events.sort()

    bands = _moon_bands(preset)
    log_prefix = f"[shard {shard}]"
    wall0 = time.time()

    for t_event, kind, fam_idx in events:
        if t_event > sim.t:
            sim.integrate(t_event, exact_finish_time=0)
            sim.synchronize()

        if kind == "inject":
            xyz, vxvyvz = _state_arrays(sim)
            ppos, pvel = xyz[0], vxvyvz[0]
            n_tp = sim.N - n_active
            if n_tp < 8:
                continue
            # Parent = a random surviving background rock of this shard.
            bg_indices = np.flatnonzero(family < 0)
            if bg_indices.size == 0:
                continue
            parent = int(rng.choice(bg_indices)) + n_active
            par_pos = xyz[parent]
            par_vel = vxvyvz[parent]
            v_orb = float(np.linalg.norm(par_vel - pvel))
            m = int(fam_sizes[fam_idx])
            dv = fam_dv[fam_idx] * v_orb
            dpos = rng.normal(0.0, 1e-4, (m, 3))
            dvel = rng.normal(0.0, dv, (m, 3))
            for k in range(m):
                sim.add(
                    x=par_pos[0] + dpos[k, 0],
                    y=par_pos[1] + dpos[k, 1],
                    z=par_pos[2] + dpos[k, 2],
                    vx=par_vel[0] + dvel[k, 0],
                    vy=par_vel[1] + dvel[k, 1],
                    vz=par_vel[2] + dvel[k, 2],
                )
            family = np.concatenate([family, np.full(m, fam_idx, dtype=np.int32)])

        elif kind in ("cull", "end"):
            xyz, vxvyvz = _state_arrays(sim)
            ppos, pvel = xyz[0], vxvyvz[0]
            tp_pos = xyz[n_active:] - ppos
            tp_vel = vxvyvz[n_active:] - pvel
            a, e, inc = elements(tp_pos, tp_vel)
            r = np.linalg.norm(tp_pos, axis=1)
            q = a * (1.0 - e)
            big_q = a * (1.0 + e)
            bad = (
                (a <= 0)
                | (e >= integ.e_max)
                | (r < integ.r_bounds[0])
                | (r > integ.r_bounds[1])
                | ~np.isfinite(a)
            )
            for a_m, half in bands:
                bad |= (q < a_m + half) & (big_q > a_m - half)
            cull = np.flatnonzero(bad)
            if cull.size:
                # REBOUND 5 remove(i) preserves particle order, so the family-id
                # array filters with the same mask. Descending order keeps the
                # not-yet-removed indices valid.
                for i in cull[::-1].tolist():
                    sim.remove(i + n_active)
                family = family[~bad]
                n_removed += cull.size
            if kind == "cull" and shard == 0:
                frac = sim.t / t_end
                elapsed = time.time() - wall0
                eta = elapsed / max(frac, 1e-9) * (1 - frac)
                print(
                    f"{log_prefix} t={sim.t / TWO_PI:7.0f}/{t_end / TWO_PI:.0f} orbits"
                    f"  alive={sim.N - n_active}  removed={n_removed}"
                    f"  elapsed={elapsed:6.0f}s eta={eta:6.0f}s",
                    flush=True,
                )

    xyz, vxvyvz = _state_arrays(sim)
    ppos, pvel = xyz[0], vxvyvz[0]
    return ShardResult(
        pos=xyz[n_active:] - ppos,
        vel=vxvyvz[n_active:] - pvel,
        family=family,
        n_removed=n_removed,
    )


def _shard_entry(args: tuple[str, int, int]) -> ShardResult:
    preset_path, shard, n_shards = args
    return simulate_shard(load_preset(preset_path), shard, n_shards)


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------


def run(preset_path: str | Path, n_shards: int | None = None, out_base: str | Path = "runs") -> Path:
    preset = load_preset(preset_path)
    if n_shards is None:
        n_shards = max(1, min((os.cpu_count() or 4) - 2, 10))
    out_dir = run_dir_for(preset, out_base)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"beltsim simulate: preset={preset.name} particles={preset.belt.n_particles} "
          f"orbits={preset.integration.n_orbits:.0f} shards={n_shards}", flush=True)
    wall0 = time.time()

    if n_shards == 1:
        results = [simulate_shard(preset, 0, 1)]
    else:
        with ProcessPoolExecutor(max_workers=n_shards) as pool:
            results = list(
                pool.map(_shard_entry, [(str(preset_path), s, n_shards) for s in range(n_shards)])
            )

    pos = np.concatenate([r.pos for r in results]).astype(np.float32)
    vel = np.concatenate([r.vel for r in results]).astype(np.float32)
    family = np.concatenate([r.family for r in results])
    n_removed = sum(r.n_removed for r in results)
    a, e, inc = elements(pos.astype(np.float64), vel.astype(np.float64))
    wall = time.time() - wall0

    np.savez_compressed(
        out_dir / "particles.npz",
        pos=pos,
        vel=vel,
        family=family,
        a=a.astype(np.float32),
        e=e.astype(np.float32),
        inc=inc.astype(np.float32),
    )
    meta = {
        "preset": preset.raw,
        "n_final": int(pos.shape[0]),
        "n_removed": int(n_removed),
        "n_shards": n_shards,
        "wall_seconds": round(wall, 1),
        "moons": [{"name": m.name, "mass": m.mass, "a": m.a} for m in preset.moons],
    }
    (out_dir / "sim-meta.json").write_text(json.dumps(meta, indent=2))
    print(f"done: {pos.shape[0]} particles alive, {n_removed} removed, "
          f"{wall:.0f}s -> {out_dir / 'particles.npz'}", flush=True)
    return out_dir
