"""Bake (Phase 2): compress the sim output without losing the chaos.

Inputs:  runs/<preset>/particles.npz  (final epoch of the N-body sim)
Outputs: runs/<preset>/bake/
  heroes.bin.gz    top-N largest bodies as literal positions (f32 records)
  density.bin.gz   polar density grid [r][theta][z], uint8, smoothed
  flow.bin.gz      coarse polar mean-velocity grid [r][theta], int8 dir + uint8 speed
  zones.bin.gz     per-r-bin zone id (uint8) derived from the radial profile
  belt-meta.json   grid dims, scales, zone boundaries, format version
  previews/*.png   visual checks of exactly what got baked

Design contract (docs/asteroid-sim-impl-log.md): the density grid preserves the
sim's actual low-frequency structure — gaps, arcs, clumps. Smoothing only
removes per-cell Poisson noise below the runtime's procedural-detail scale;
it must stay narrow (sigma ~1.5 cells) so young family clumps survive.

Sizes: every surviving particle gets a diameter from the cumulative power law
N(>D) ~ D^-size_slope (deterministic given the preset seed). The top
`hero_count` become heroes (literal storage); the REST feed the density grid,
so heroes are never double-counted by the background field.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.ndimage import gaussian_filter, gaussian_filter1d

from .config import load_preset

FORMAT_VERSION = 1


def _power_law_diameters(
    n: int, slope: float, d_min: float, d_max: float, seed: int
) -> np.ndarray:
    rng = np.random.default_rng([seed, 31337])
    u = rng.uniform(0.0, 1.0, n)
    d = d_min * u ** (-1.0 / slope)
    return np.minimum(d, d_max)


def _polar_indices(
    pos: np.ndarray, nr: int, ntheta: int, nz: int, r_min: float, r_max: float, z_max: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    r = np.hypot(pos[:, 0], pos[:, 1])
    theta = np.arctan2(pos[:, 1], pos[:, 0])  # [-pi, pi)
    ir = ((r - r_min) / (r_max - r_min) * nr).astype(np.int64)
    itheta = ((theta + np.pi) / (2 * np.pi) * ntheta).astype(np.int64) % ntheta
    iz = ((pos[:, 2] + z_max) / (2 * z_max) * nz).astype(np.int64)
    ok = (ir >= 0) & (ir < nr) & (iz >= 0) & (iz < nz)
    return ir, itheta, iz, ok


def _detect_zones(radial_profile: np.ndarray) -> np.ndarray:
    """Label each r-bin: 0 = void, odd = dense band k, even = sparse fringe/gap.

    Three levels of the (smoothed) radial profile vs its 95th percentile:
    dense band > 45%, sparse (present but thin — moon-eroded fringes, smeared
    resonance shoulders) > 4%, void below. Eccentricity smears a-space gaps in
    physical radius, so the radial anatomy that survives is band/fringe/void;
    azimuthal variation (families, arcs) lives in the 2D density itself. This
    replaces the hardcoded pocket x-bands at runtime.
    """
    smooth = gaussian_filter1d(radial_profile.astype(np.float64), 6.0)
    peak = np.percentile(smooth, 95)
    dense = smooth > 0.45 * peak
    present = smooth > 0.04 * peak
    zones = np.zeros(len(smooth), dtype=np.uint8)
    band_id = 0
    in_band = False
    for i in range(len(smooth)):
        if not present[i]:
            in_band = False
            continue
        if dense[i]:
            if not in_band:
                band_id += 1
                in_band = True
            zones[i] = 2 * band_id - 1
        else:
            in_band = False
            zones[i] = max(2, 2 * band_id)  # sparse fringe (leading fringe shares id 2)
    return zones


def bake(run_dir: str | Path) -> list[Path]:
    run_dir = Path(run_dir)
    meta_in = json.loads((run_dir / "sim-meta.json").read_text())
    preset = load_preset_from_meta(meta_in)
    cfg = preset.bake
    data = np.load(run_dir / "particles.npz")
    pos, vel, family = data["pos"].astype(np.float64), data["vel"].astype(np.float64), data["family"]
    n = pos.shape[0]

    out_dir = run_dir / "bake"
    out_dir.mkdir(exist_ok=True)
    previews = out_dir / "previews"
    previews.mkdir(exist_ok=True)
    written: list[Path] = []

    # --- size assignment + hero split ---------------------------------------
    diam = _power_law_diameters(n, cfg.size_slope, cfg.size_d_min, cfg.size_d_max, preset.seed)
    order = np.argsort(-diam)
    # Heroes must lie inside the baked volume (the runtime grid is sized from r_max/z_max;
    # a hero outside it cannot exist at runtime — found the hard way: 3/2000 smoke heroes
    # sat above z_max and silently vanished at decode).
    r_all = np.hypot(pos[:, 0], pos[:, 1])
    inside = (np.abs(pos[:, 2]) < cfg.z_max * 0.999) & (r_all > cfg.r_min) & (r_all < cfg.r_max)
    order = order[inside[order]]
    hero_idx = order[: cfg.hero_count]
    rest_idx = np.concatenate([order[cfg.hero_count :], np.flatnonzero(~inside)])

    heroes = np.zeros((hero_idx.size,), dtype=[
        ("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("d", "<f4"), ("family", "<i2"), ("pad", "<i2"),
    ])
    heroes["x"], heroes["y"], heroes["z"] = pos[hero_idx, 0], pos[hero_idx, 1], pos[hero_idx, 2]
    heroes["d"] = diam[hero_idx]
    heroes["family"] = family[hero_idx]
    p = out_dir / "heroes.bin.gz"
    p.write_bytes(gzip.compress(heroes.tobytes(), 9))
    written.append(p)

    # --- density grid from the non-hero remainder -----------------------------
    nr, ntheta, nz = cfg.nr, cfg.ntheta, cfg.nz
    ir, itheta, iz, ok = _polar_indices(pos[rest_idx], nr, ntheta, nz, cfg.r_min, cfg.r_max, cfg.z_max)
    flat = (ir[ok] * ntheta + itheta[ok]) * nz + iz[ok]
    counts = np.bincount(flat, minlength=nr * ntheta * nz).reshape(nr, ntheta, nz).astype(np.float32)

    # Smooth per z-layer: wrap in theta, clamp in r. Narrow sigma — Poisson
    # denoise only, family clumps span tens of theta cells and must survive.
    for k in range(nz):
        counts[:, :, k] = gaussian_filter(counts[:, :, k], sigma=1.5, mode=("nearest", "wrap"))
    scale = float(np.percentile(counts[counts > 0], 99.9)) if np.any(counts > 0) else 1.0
    density_u8 = np.clip(np.round(counts / scale * 255.0), 0, 255).astype(np.uint8)
    p = out_dir / "density.bin.gz"
    p.write_bytes(gzip.compress(density_u8.tobytes(), 9))
    written.append(p)

    # --- flow field (coarse, all particles) -----------------------------------
    fnr, fntheta = 256, 256
    fir, fitheta, _, fok = _polar_indices(pos, fnr, fntheta, 1, cfg.r_min, cfg.r_max, 1e9)
    fflat = fir[fok] * fntheta + fitheta[fok]
    cell_n = np.bincount(fflat, minlength=fnr * fntheta).astype(np.float64)
    mean_v = np.zeros((fnr * fntheta, 3))
    for c in range(3):
        mean_v[:, c] = np.bincount(fflat, weights=vel[fok, c], minlength=fnr * fntheta)
    nonzero = cell_n > 0
    mean_v[nonzero] /= cell_n[nonzero, None]
    speed = np.linalg.norm(mean_v, axis=1)
    vmax = float(speed.max()) if speed.size else 1.0
    dirs = np.zeros_like(mean_v)
    dirs[speed > 0] = mean_v[speed > 0] / speed[speed > 0, None]
    flow = np.zeros((fnr * fntheta, 4), dtype=np.int8)
    flow[:, :3] = np.clip(np.round(dirs * 127), -127, 127).astype(np.int8)
    flow[:, 3] = np.clip(np.round(speed / vmax * 127), 0, 127).astype(np.int8)
    p = out_dir / "flow.bin.gz"
    p.write_bytes(gzip.compress(flow.tobytes(), 9))
    written.append(p)

    # --- zones from the radial profile ----------------------------------------
    radial = counts.sum(axis=(1, 2))
    zones = _detect_zones(radial)
    p = out_dir / "zones.bin.gz"
    p.write_bytes(gzip.compress(zones.tobytes(), 9))
    written.append(p)

    # --- metadata ---------------------------------------------------------------
    # Content-addressed id: clients append it as a cache-busting query param so a fresh
    # belt-meta.json can never pair with a stale cached binary (the lengths guard in the
    # runtime decoder turns that mismatch into a hard error).
    import hashlib

    bake_id = hashlib.sha1(density_u8.tobytes() + heroes.tobytes()).hexdigest()[:12]
    meta = {
        "formatVersion": FORMAT_VERSION,
        "bakeId": bake_id,
        "preset": meta_in["preset"]["name"] if isinstance(meta_in["preset"], dict) else str(meta_in["preset"]),
        "seed": preset.seed,
        "counts": {"heroes": int(hero_idx.size), "background": int(rest_idx.size)},
        "density": {
            "nr": nr, "ntheta": ntheta, "nz": nz,
            "rMin": cfg.r_min, "rMax": cfg.r_max, "zMax": cfg.z_max,
            "countScale": scale,
            "densityScale": cfg.density_scale,
            "order": "[r][theta][z], C-order, uint8",
        },
        "flow": {"nr": fnr, "ntheta": fntheta, "vMax": vmax, "order": "[r][theta], int8 xyz dir + speed/127*vMax"},
        "zones": {"nr": nr, "encoding": "0=void, odd=band, even=gap"},
        "heroes": {"record": "f32 x,y,z,d + i16 family + i16 pad (20 bytes LE)", "sizeSlope": cfg.size_slope},
        "moons": meta_in["moons"],
    }
    p = out_dir / "belt-meta.json"
    p.write_text(json.dumps(meta, indent=2))
    written.append(p)

    # --- previews ---------------------------------------------------------------
    fig, ax = plt.subplots(figsize=(12, 6))
    img = np.log1p(density_u8.sum(axis=2).astype(np.float32))
    ax.imshow(img.T, origin="lower", aspect="auto", cmap="magma",
              extent=(cfg.r_min, cfg.r_max, -180, 180), interpolation="nearest")
    ax.set_xlabel("r")
    ax.set_ylabel("theta (deg)")
    ax.set_title("baked density (z-summed, log) — gaps are vertical lanes, families are blobs/streaks")
    fig.savefig(previews / "density-polar.png", dpi=160, bbox_inches="tight")
    plt.close(fig)

    # Cartesian re-projection of the baked grid: what the far-field will look like.
    fig, ax = plt.subplots(figsize=(11, 11))
    rr = np.linspace(cfg.r_min, cfg.r_max, nr)
    tt = np.linspace(-np.pi, np.pi, ntheta, endpoint=False)
    R, T = np.meshgrid(rr, tt, indexing="ij")
    ax.pcolormesh(R * np.cos(T), R * np.sin(T), img, cmap="magma", shading="auto")
    ax.scatter(heroes["x"][:4000], heroes["y"][:4000], s=0.5, c="#7fd4ff", alpha=0.6, lw=0)
    ax.set_aspect("equal")
    ax.set_title("baked density (cartesian) + largest 4k heroes (cyan)")
    fig.savefig(previews / "density-cartesian.png", dpi=170, bbox_inches="tight")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(12, 4))
    ax.plot(rr, radial / max(radial.max(), 1e-9), color="#3a6ea5")
    z = zones.astype(float)
    ax.fill_between(rr, 0, 1, where=(zones % 2 == 1), alpha=0.12, color="#27ae60", label="band")
    ax.fill_between(rr, 0, 1, where=((zones % 2 == 0) & (zones > 0)), alpha=0.12, color="#c0392b", label="gap")
    ax.legend()
    ax.set_xlabel("r")
    ax.set_title("radial profile + detected zones")
    fig.savefig(previews / "zones.png", dpi=160, bbox_inches="tight")
    plt.close(fig)

    total = sum(f.stat().st_size for f in written if f.suffix == ".gz")
    print(f"bake artifacts: {total / 1e6:.2f} MB compressed "
          f"({', '.join(f'{f.name}={f.stat().st_size/1e6:.2f}MB' for f in written if f.suffix == '.gz')})")
    return written


def load_preset_from_meta(meta_in: dict):
    """Rebuild the Preset from the config echo stored in sim-meta.json, so a
    bake always uses the exact knobs of the run it bakes (not a since-edited
    preset file)."""
    import tempfile

    raw = meta_in["preset"]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(raw, f)
        path = f.name
    return load_preset(path)
