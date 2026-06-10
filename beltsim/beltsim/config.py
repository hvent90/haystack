"""Preset loading + the canonical knob schema for the belt pipeline.

A preset JSON is the single tuning surface for the whole sim -> bake pipeline.
Which pipeline stage a knob requires re-running is documented in README.md
("Knobs and what they cost"). Units are normalized: G = 1, planet mass = 1,
belt inner edge a ~ 1 (orbital period 2*pi at a = 1). The mapping to world
meters happens at runtime, not here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Moon:
    name: str
    mass: float  # mass ratio vs the planet (planet = 1)
    a: float  # semi-major axis, normalized
    e: float = 0.0
    inc: float = 0.0  # radians


@dataclass(frozen=True)
class BeltConfig:
    n_particles: int
    a_min: float
    a_max: float
    e_sigma: float  # Rayleigh sigma of initial eccentricity
    inc_sigma: float  # Rayleigh sigma of initial inclination (radians) -> vertical scale height


@dataclass(frozen=True)
class FamiliesConfig:
    count: int  # number of parent-breakup events
    particle_fraction: float  # fraction of n_particles that are family debris
    dv_over_vorb_min: float  # ejection velocity dispersion as a fraction of orbital velocity
    dv_over_vorb_max: float
    inject_window: tuple[float, float]  # (start, end) as fractions of t_end; staggered ages -> staggered shear


@dataclass(frozen=True)
class IntegrationConfig:
    n_orbits: float  # total integration time, in orbits at a = 1
    dt_fraction: float  # dt as a fraction of the SHORTEST massive-body period
    cull_every_orbits: float  # cadence of the e-pump / moon-crossing cull
    e_max: float  # cull: eccentricity above this is removed (resonance-pumped)
    r_bounds: tuple[float, float]  # cull: physical radius outside this is removed


@dataclass(frozen=True)
class BakeConfig:
    # Density / flow field resolution (polar: radius x azimuth x vertical).
    nr: int
    ntheta: int
    nz: int
    r_min: float
    r_max: float
    z_max: float
    hero_count: int  # top-N largest bodies stored as literal positions
    size_slope: float  # cumulative power-law slope: N(>D) ~ D^-size_slope
    size_d_min: float  # smallest hero diameter (normalized units, only sets the sampling floor)
    size_d_max: float
    density_scale: float  # global density multiplier (cheap knob: bake/runtime only)
    # Optional world-mapping block, emitted verbatim into belt-meta.json's "world" key.
    # world_scale: meters per normalized unit (runtime overrides its legacy default with
    # this); planet_radius: rendered planet radius in normalized units. Saturn preset:
    # world_scale 7.45e7 (a=1 -> 74,500 km, C-ring inner edge), planet_radius 0.809
    # (60,268 km / 74,500 km). Presets without it keep the runtime defaults.
    world_scale: float | None = None
    planet_radius: float | None = None


@dataclass(frozen=True)
class Preset:
    name: str
    seed: int
    moons: list[Moon]
    belt: BeltConfig
    families: FamiliesConfig
    integration: IntegrationConfig
    bake: BakeConfig
    raw: dict[str, Any] = field(repr=False, default_factory=dict)


def load_preset(path: str | Path) -> Preset:
    path = Path(path)
    raw = json.loads(path.read_text())
    fam = raw["families"]
    integ = raw["integration"]
    bake = raw["bake"]
    return Preset(
        name=raw.get("name", path.stem),
        seed=int(raw["seed"]),
        moons=[Moon(**m) for m in raw["moons"]],
        belt=BeltConfig(**raw["belt"]),
        families=FamiliesConfig(
            count=int(fam["count"]),
            particle_fraction=float(fam["particle_fraction"]),
            dv_over_vorb_min=float(fam["dv_over_vorb_min"]),
            dv_over_vorb_max=float(fam["dv_over_vorb_max"]),
            inject_window=(float(fam["inject_window"][0]), float(fam["inject_window"][1])),
        ),
        integration=IntegrationConfig(
            n_orbits=float(integ["n_orbits"]),
            dt_fraction=float(integ["dt_fraction"]),
            cull_every_orbits=float(integ["cull_every_orbits"]),
            e_max=float(integ["e_max"]),
            r_bounds=(float(integ["r_bounds"][0]), float(integ["r_bounds"][1])),
        ),
        bake=BakeConfig(**bake),
        raw=raw,
    )


def run_dir_for(preset: Preset, base: str | Path = "runs") -> Path:
    return Path(base) / preset.name
