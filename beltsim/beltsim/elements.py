"""Vectorized planet-centric orbital elements from cartesian state (numpy).

REBOUND's per-particle orbit accessors are C-backed but loop in Python; for
10^5..10^6 test particles we pull raw state arrays once and do the element
math vectorized. mu is G * M(planet) = 1 in normalized units.
"""

from __future__ import annotations

import numpy as np


def elements(
    pos: np.ndarray, vel: np.ndarray, mu: float = 1.0
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (a, e, inc) per particle. pos/vel are (N, 3) planet-centric."""
    r = np.linalg.norm(pos, axis=1)
    v2 = np.einsum("ij,ij->i", vel, vel)
    energy = 0.5 * v2 - mu / np.maximum(r, 1e-12)
    with np.errstate(divide="ignore", invalid="ignore"):
        a = -mu / (2.0 * energy)

    h = np.cross(pos, vel)
    hnorm = np.linalg.norm(h, axis=1)
    # e vector = (v x h)/mu - r_hat
    evec = np.cross(vel, h) / mu - pos / np.maximum(r, 1e-12)[:, None]
    e = np.linalg.norm(evec, axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        inc = np.arccos(np.clip(h[:, 2] / np.maximum(hnorm, 1e-12), -1.0, 1.0))
    return a, e, inc
