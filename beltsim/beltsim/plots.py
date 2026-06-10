"""Diagnostic plots for a sim run: the eyes of Phase 1.

Reads runs/<preset>/particles.npz and renders:
  - semi-major-axis histogram with resonance markers (Kirkwood gaps)
  - face-on density map (gaps, ringlets, arcs, clumps)
  - eccentricity vs a (resonance pumping structure)
  - edge-on profile (vertical scale height)
  - family panels (young = tight clump, old = sheared arc/ring)
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def _resonances(moons: list[dict], a_lo: float, a_hi: float) -> list[tuple[float, str]]:
    """First/second-order mean-motion resonance radii that land inside the belt."""
    marks: list[tuple[float, str]] = []
    pairs = [(2, 1), (3, 1), (5, 2), (7, 3), (4, 1), (5, 3), (3, 2)]
    for moon in moons:
        for j, k in pairs:
            # Interior resonance of an outer moon: particle period = (k/j) * moon period.
            a_int = moon["a"] * (k / j) ** (2.0 / 3.0)
            if a_lo < a_int < a_hi:
                marks.append((a_int, f"{j}:{k} {moon['name']}"))
            # Exterior resonance of an inner moon.
            a_ext = moon["a"] * (j / k) ** (2.0 / 3.0)
            if a_lo < a_ext < a_hi:
                marks.append((a_ext, f"{k}:{j} {moon['name']}"))
    return marks


def render(run_dir: str | Path) -> list[Path]:
    run_dir = Path(run_dir)
    data = np.load(run_dir / "particles.npz")
    meta = json.loads((run_dir / "sim-meta.json").read_text())
    plots_dir = run_dir / "plots"
    plots_dir.mkdir(exist_ok=True)

    pos = data["pos"]
    a, e, fam = data["a"], data["e"], data["family"]
    moons = meta["moons"]
    belt = meta["preset"]["belt"]
    a_lo, a_hi = belt["a_min"] * 0.78, belt["a_max"] * 1.12
    out: list[Path] = []

    # --- 1. Kirkwood histogram ------------------------------------------------
    fig, ax = plt.subplots(figsize=(13, 6))
    sel = (a > a_lo) & (a < a_hi)
    ax.hist(a[sel], bins=420, color="#3a6ea5", lw=0)
    for a_r, label in _resonances(moons, a_lo, a_hi):
        ax.axvline(a_r, color="#c0392b", alpha=0.55, lw=1)
        ax.text(a_r, ax.get_ylim()[1] * 0.97, label, rotation=90, va="top", ha="right",
                fontsize=7, color="#c0392b")
    for moon in moons:
        if a_lo < moon["a"] < a_hi:
            ax.axvline(moon["a"], color="#27ae60", alpha=0.8, lw=1.4, ls="--")
            ax.text(moon["a"], ax.get_ylim()[1] * 0.97, f"moon {moon['name']}", rotation=90,
                    va="top", ha="right", fontsize=7, color="#27ae60")
    ax.set_xlabel("semi-major axis (normalized)")
    ax.set_ylabel("count")
    ax.set_title(f"{meta['preset']['name']}: a-distribution after {meta['preset']['integration']['n_orbits']:.0f} orbits "
                 f"({meta['n_final']:,} alive, {meta['n_removed']:,} removed)")
    p = plots_dir / "kirkwood-histogram.png"
    fig.savefig(p, dpi=160, bbox_inches="tight")
    plt.close(fig)
    out.append(p)

    # --- 2. Face-on density map ------------------------------------------------
    lim = a_hi
    fig, ax = plt.subplots(figsize=(11, 11))
    h, xe, ye = np.histogram2d(pos[:, 0], pos[:, 1], bins=900, range=[[-lim, lim], [-lim, lim]])
    ax.imshow(np.log1p(h.T), origin="lower", extent=(-lim, lim, -lim, lim),
              cmap="magma", interpolation="nearest")
    ax.set_title(f"{meta['preset']['name']}: face-on density (log scale)")
    ax.set_xlabel("x")
    ax.set_ylabel("y")
    p = plots_dir / "face-on-density.png"
    fig.savefig(p, dpi=170, bbox_inches="tight")
    plt.close(fig)
    out.append(p)

    # --- 3. e vs a (resonance pumping) -----------------------------------------
    fig, ax = plt.subplots(figsize=(13, 6))
    sub = np.random.default_rng(1).choice(len(a), size=min(len(a), 120_000), replace=False)
    ax.scatter(a[sub], e[sub], s=0.5, alpha=0.25, c="#2c3e50", lw=0)
    for a_r, _ in _resonances(moons, a_lo, a_hi):
        ax.axvline(a_r, color="#c0392b", alpha=0.35, lw=0.8)
    ax.set_xlim(a_lo, a_hi)
    ax.set_ylim(0, min(0.5, float(np.percentile(e[sel], 99.8)) * 1.6 + 0.02))
    ax.set_xlabel("semi-major axis")
    ax.set_ylabel("eccentricity")
    ax.set_title("e vs a — resonance pumping")
    p = plots_dir / "e-vs-a.png"
    fig.savefig(p, dpi=160, bbox_inches="tight")
    plt.close(fig)
    out.append(p)

    # --- 4. Edge-on profile ------------------------------------------------------
    r = np.linalg.norm(pos[:, :2], axis=1)
    fig, ax = plt.subplots(figsize=(13, 4))
    zmax = meta["preset"]["bake"]["z_max"] * 1.6
    h, _, _ = np.histogram2d(r, pos[:, 2], bins=(700, 160), range=[[a_lo, a_hi], [-zmax, zmax]])
    ax.imshow(np.log1p(h.T), origin="lower", extent=(a_lo, a_hi, -zmax, zmax),
              cmap="magma", aspect="auto", interpolation="nearest")
    ax.set_xlabel("cylindrical r")
    ax.set_ylabel("z")
    ax.set_title("edge-on density (log)")
    p = plots_dir / "edge-on.png"
    fig.savefig(p, dpi=160, bbox_inches="tight")
    plt.close(fig)
    out.append(p)

    # --- 5. Families --------------------------------------------------------------
    fam_ids = np.unique(fam[fam >= 0])
    if fam_ids.size:
        fig, axes = plt.subplots(2, 2, figsize=(13, 13))
        ax = axes[0, 0]
        is_fam = fam >= 0
        ax.scatter(pos[~is_fam, 0], pos[~is_fam, 1], s=0.3, alpha=0.05, c="#888888", lw=0)
        cmap = plt.get_cmap("tab20")
        for fi in fam_ids:
            m = fam == fi
            ax.scatter(pos[m, 0], pos[m, 1], s=0.7, alpha=0.5, color=cmap(int(fi) % 20), lw=0)
        ax.set_title("all families over background")
        ax.set_aspect("equal")
        # Zooms: pick three families spread across injection order (proxy for age).
        picks = [fam_ids[0], fam_ids[len(fam_ids) // 2], fam_ids[-1]]
        for axi, fi in zip([axes[0, 1], axes[1, 0], axes[1, 1]], picks):
            m = fam == fi
            axi.scatter(pos[~is_fam, 0], pos[~is_fam, 1], s=0.3, alpha=0.04, c="#aaaaaa", lw=0)
            axi.scatter(pos[m, 0], pos[m, 1], s=2.0, alpha=0.8,
                        color=cmap(int(fi) % 20), lw=0)
            cx, cy = pos[m, 0].mean(), pos[m, 1].mean()
            span = max(float(np.ptp(pos[m, 0])), float(np.ptp(pos[m, 1])), 0.2) * 0.75
            axi.set_xlim(cx - span, cx + span)
            axi.set_ylim(cy - span, cy + span)
            axi.set_title(f"family {fi} ({int(m.sum())} members) — injected earlier = more sheared")
        p = plots_dir / "families.png"
        fig.savefig(p, dpi=150, bbox_inches="tight")
        plt.close(fig)
        out.append(p)

    return out
