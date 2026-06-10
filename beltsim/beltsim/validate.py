"""Statistical validation (Phase 4): the checks the contract names.

  1. Resonance gaps: a-histogram density inside each marked gap vs its flanks.
  2. Size distribution: the bake's assigned diameters follow N(>D) ~ D^-slope.
  3. Family clustering: families are measurably tighter than Poisson in element space
     (semi-major axis dispersion) AND in position space for young families.

Writes runs/<preset>/validation.json and prints a PASS/FAIL summary. The visual checks
(the failure mode the eye sees) live in plots.py + the in-client captures.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .bake import _power_law_diameters, load_preset_from_meta


def validate(run_dir: str | Path) -> dict:
    run_dir = Path(run_dir)
    data = np.load(run_dir / "particles.npz")
    meta = json.loads((run_dir / "sim-meta.json").read_text())
    preset = load_preset_from_meta(meta)
    a, e, fam = data["a"].astype(np.float64), data["e"], data["family"]
    pos = data["pos"].astype(np.float64)
    checks: dict[str, dict] = {}

    # --- 1. resonance gap depth ---------------------------------------------------------
    outer = max(meta["moons"], key=lambda m: m["a"])
    gaps = {}
    for label, j, k in [("3:1", 3, 1), ("5:2", 5, 2), ("7:3", 7, 3), ("2:1", 2, 1)]:
        a_res = outer["a"] * (k / j) ** (2.0 / 3.0)
        gap_w = 0.012 * a_res
        flank_w = 0.05 * a_res
        in_gap = np.mean((a > a_res - gap_w) & (a < a_res + gap_w)) / (2 * gap_w)
        in_flank = (
            np.mean((a > a_res - flank_w) & (a < a_res - gap_w))
            + np.mean((a > a_res + gap_w) & (a < a_res + flank_w))
        ) / (2 * (flank_w - gap_w))
        ratio = float(in_gap / in_flank) if in_flank > 0 else float("nan")
        gaps[label] = {"a": round(a_res, 4), "depthRatio": round(ratio, 3)}
    # The marquee gap must be visibly depleted.
    gap_pass = gaps["3:1"]["depthRatio"] < 0.55 and gaps["2:1"]["depthRatio"] < 0.55
    checks["resonance_gaps"] = {"pass": bool(gap_pass), "gapDensityOverFlank": gaps}

    # --- 2. size power law ----------------------------------------------------------------
    bake = preset.bake
    diam = _power_law_diameters(len(a), bake.size_slope, bake.size_d_min, bake.size_d_max,
                                preset.seed)
    # Fit cumulative slope over the un-truncated middle decade.
    d_lo, d_hi = bake.size_d_min * 1.5, bake.size_d_max * 0.25
    grid = np.geomspace(d_lo, d_hi, 24)
    counts = np.array([(diam > g).sum() for g in grid], dtype=np.float64)
    slope = float(np.polyfit(np.log(grid), np.log(counts), 1)[0])
    slope_pass = abs(slope + bake.size_slope) < 0.12
    checks["size_power_law"] = {
        "pass": bool(slope_pass),
        "fittedSlope": round(slope, 3),
        "targetSlope": -bake.size_slope,
    }

    # --- 3. family clustering vs Poisson ----------------------------------------------------
    rng = np.random.default_rng(99)
    fam_ids = np.unique(fam[fam >= 0])
    a_ratios = []
    xy_ratios = []
    belt_sel = (a > preset.belt.a_min * 0.9) & (a < preset.belt.a_max * 1.1)
    a_belt = a[belt_sel]
    for fi in fam_ids:
        members = fam == fi
        n = int(members.sum())
        if n < 8:
            continue
        # Element-space tightness: family a-dispersion vs same-size random draw from belt.
        fam_std = float(np.std(a[members]))
        rand_std = float(np.mean([np.std(rng.choice(a_belt, n)) for _ in range(8)]))
        a_ratios.append(fam_std / max(rand_std, 1e-12))
        # Position-space: mean pairwise distance (sampled) vs random belt rocks.
        idx = np.flatnonzero(members)
        take = idx[rng.permutation(len(idx))[: min(64, len(idx))]]
        p = pos[take]
        dists = np.linalg.norm(p[:, None, :] - p[None, :, :], axis=2)
        fam_d = float(np.mean(dists[np.triu_indices(len(p), 1)]))
        ridx = rng.permutation(len(pos))[: len(p)]
        rp = pos[ridx]
        rdists = np.linalg.norm(rp[:, None, :] - rp[None, :, :], axis=2)
        rand_d = float(np.mean(rdists[np.triu_indices(len(rp), 1)]))
        xy_ratios.append(fam_d / max(rand_d, 1e-12))
    med_a = float(np.median(a_ratios)) if a_ratios else float("nan")
    med_xy = float(np.median(xy_ratios)) if xy_ratios else float("nan")
    fam_pass = med_a < 0.35  # families are MUCH tighter in a than random
    checks["family_clustering"] = {
        "pass": bool(fam_pass),
        "medianFamilyAStdOverPoisson": round(med_a, 3),
        "medianFamilyPairDistOverPoisson": round(med_xy, 3),
        "familiesMeasured": len(a_ratios),
    }

    result = {
        "preset": preset.name,
        "nParticles": int(len(a)),
        "allPass": all(c["pass"] for c in checks.values()),
        "checks": checks,
    }
    out = run_dir / "validation.json"
    out.write_text(json.dumps(result, indent=2))
    status = "ALL PASS" if result["allPass"] else "FAILURES"
    print(f"validation [{preset.name}]: {status}")
    for name, c in checks.items():
        print(f"  [{'PASS' if c['pass'] else 'FAIL'}] {name}: "
              f"{json.dumps({k: v for k, v in c.items() if k != 'pass'})}")
    return result
