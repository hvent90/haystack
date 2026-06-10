# Elite Dangerous belt/ring reference — research for the haystack belt

Compiled 2026-06-09/10 from Frontier forums (via reader proxy — the official forum is
WAF-blocked for direct fetch), Steam discussions, r/EliteDangerous + r/EliteMiners (via
the Arctic Shift / pullpush archives), the Fandom wiki API, EDSM's public API (mirrors
exact in-game system-map values), edastro.com records, mining guides, patch notes, and
GraphicsConfiguration.xml dumps.

**Confidence labels** used throughout: *measured* (in-game instruments, API data, config
files, model extraction), *community-estimated* (player consensus from play, no
instrument), *eyeballed* (from footage/screenshots).

---

## 0. The two environments — and which one we model

ED has two completely different "asteroid" environments, and players mean the second
when they talk about flying through a belt:

| | Belt clusters | Planetary rings |
|---|---|---|
| What it is | Navigationally-selectable POI inside a star-orbiting belt | Dense flat ring system around a planet; where all mining happens |
| Rock count | **~6 (small) / ~12 (large)** rocks per cluster, one instance a few km across (*community-measured*, [FF 465155](https://forums.frontier.co.uk/threads/deep-core-asteroids-can-be-found-in-belt-clusters.465155/)) | "Thousands of actual asteroids at the same time" pre-2020, still hundreds-to-thousands now (*eyeballed*, [r/ED 2eeoh8](https://www.reddit.com/r/EliteDangerous/comments/2eeoh8/)) |
| Density | Sol main belt: 0.009 kg/m² nominal — ~10⁻⁶× a mining ring (*measured*, EDSM) | 4,400–10,000 kg/m² nominal surface density (*measured*, EDSM masses/radii) |
| Motion | Rocks completely motionless ([FF 263933](https://forums.frontier.co.uk/showthread.php/263933-Belt-cluster-asteroids-are-completely-motionless)) | Nearly every rock tumbles slowly |
| Player verdict | "Famously sparse and disappointing", "worth zero" | The "zooming through a belt" fantasy |

**Recommendation: model the planetary-ring experience.** Belt clusters are the thing
players complain about; rings are the thing they screenshot. Everything below is
anchored on rings (clusters documented above for the record).

## 1. Asteroid size range and distribution

- **Hard anchor: a core asteroid model extracted at 964 × 747 × 713 m** (a dissenting
  re-measure says 890 × 654 × 630 m) — the big crackable rocks are **0.7–1.0 km class**
  (*measured*, [r/ED a84ytm](https://www.reddit.com/r/EliteDangerous/comments/a84ytm/)).
- Smallest *targetable* rocks ≈ "size of a Keelback" (~52 m) → **~30–60 m**
  (*community-estimated*, [Steam](https://steamcommunity.com/app/359320/discussions/0/2844543519796574699/)).
  Smallest distinctly *rendered* debris **~5–20 m**; mining fragments ~1–2 m (*eyeballed*).
- **The cockpit view is dominated by ~50–300 m lumpy rocks**, with frequent ~500 m
  blockers and the rare km-class monster (*eyeballed* + r/EliteMiners consensus). Not a
  clean power law — reads as a broad mid-heavy mix because ED scales a small mesh
  library rather than sampling a size distribution.
- Core rocks: exactly one fixed mesh + size per ring type, ~1 in 10,000 rocks, ~20–50 km
  apart (*community-measured*, cold-n-sour).

## 2. Spacing and density

- **"Asteroids are at least 300 m apart"** (*community-estimated*, Fandom forum posts).
  Feel range **~150–500 m** between neighbours: "tight flying with my Anaconda" (150 m
  ship) in metallic rings; "I couldn't fly for 5 seconds without hitting one" (2015 era).
- Mapped rock-to-rock hops between *selected* good rocks: **1.45–3.48 km** (*measured*
  with in-game target distances, [asteroid-mapping guide
  szz0ho](https://www.reddit.com/r/EliteMiners/comments/szz0ho/)).
- **Mass-budget cross-check** (*derived from measured EDSM masses*): mining rings cluster
  at 4.4–10 t/m² nominal surface density; with a 1–2 km slab and 15–30 m mean rock
  radius that lands at **~15–260 rocks/km³**; the player-reported 300–500 m spacing
  implies **~8–37 rocks/km³**. Central target: **~5–10 rocks/km³**.
- Rendered density is **uniform and identical across all rings** regardless of nominal
  system-map density (>100× mass range, same look inside — *community-measured*,
  cold-n-sour [hvb3nvl](https://www.reddit.com/r/EliteMiners/comments/siprp1/)). The
  visual field is cosmetic and constant; hotspots change loot tables, not geometry.

## 3. Ring geometry

- **Slab thickness ≈ 2–4 km full** ("several km thick"; flying 2 km perpendicular from a
  midplane rock reliably exits the layer — *community-estimated*,
  [funrpkh](https://www.reddit.com/r/EliteMiners/comments/h7u96t/)). Constant across all
  rings. Near-hard vertical edge (standard technique: hover just outside the slab and
  look in; the mapping community treats rings as 2D). The "hundreds of meters" figures
  in forums are about *real* rings (Saturn: 10 m–1 km), quoted to complain ED's are too
  thick.
- **Inner/outer radii** (*measured*, EDSM API): typical generated ring inner
  10,000–150,000 km, outer 40,000–500,000 km, width 3,000–400,000 km. Delkar 7 A
  (metallic): 126,040→173,750 km. Metallic rings are the narrow innermost ones;
  rocky/icy the wide outer ones. 88% of ED rings extend beyond the parent's Roche limit
  (*measured survey*, CMDR malenfant) — they're systematically too wide vs physics.
- **Edges cut nearly hard** — "the edge of an asteroid ring" is a screenshot genre;
  inter-ring gaps are empty and flyable.
- **Render structure**: detailed rocks in a **~5–10 km bubble** (post-Jan-2020,
  *eyeballed*, [FF 536049](https://forums.frontier.co.uk/threads/the-new-ring-system-rendering-limit-post-jan-patch.536049/));
  impostor/sprite shell out to **~20–25 km** (*measured* via the fighter-relog
  persistence bubble + the 20 km RES radius); a flat textured sheet beyond. Players
  notice rocks "inflate as you get near them" (LOD scale-in).

## 4. Look of individual rocks

- **Shape language: lumpy potato** ("Space Potato™"), irregular ovoids with large
  rounded protrusions and craters big enough to park a fighter in. **No angular shards.**
- **Mesh library: ~6 generic models per ring type** (+ exactly 1 core mesh per type),
  reused at random scale/orientation (*community-measured*, mapping guides). Decoys that
  look "99% like the core rock" are a gameplay feature of the tiny library.
- **Surface detail is famously LOW for the scale** — "pixels the size of houses", soft
  normal-map lumps, no greebles. Players say rocks read smaller than their true size
  *because* detail is missing. (Implication for us: low-poly displaced rocks are
  authentic; what matters is silhouette lumpiness, not micro-detail.)
- **Color/albedo by ring type** (all *eyeballed* — no measured albedo exists):
  - **Icy**: bright white, blue-grey shadows, by far the brightest; dense animated
    sparkle/shimmer (GPU-heavy in VR); ring reads white/translucent from orbit.
  - **Rocky**: mid grey-brown, matte, diffuse.
  - **Metallic**: darkest — dark umber/rust with silvery broad-specular glints; innermost rings.
  - **Metal-rich**: between metallic and rocky, brown with metallic flecks.
  - Caveat: the iconic yellow/orange glow in mining footage is the **Pulse Wave scanner
    overlay**, not material color.
- **Rotation**: nearly every ring rock tumbles; independent axes/rates; ~0.3% near-still;
  typical period **~1–5 min/rev (0.02–0.1 rad/s)**, fast ones tens of seconds
  (~0.2–0.6 rad/s) (*eyeballed*; activation is player-proximity-gated in ED).
- **No relative drift**: the ring is a rigid body (uniform angular velocity, Ian
  Doncaster on [FF 477050](https://forums.frontier.co.uk/threads/contra-rotating-planetary-rings-or-bug.477050/));
  rock positions are deterministic and persistent — players build maps and return.

## 5. Atmosphere and lighting

- **Volumetric ring fog is a named engine feature** (Beyond 3.3, Dec 2018: "striking god
  rays… light diffusion") with config knobs `RingQuality`, `FogMotesEnabled`,
  `StepsPerPixel`, `DownscalingFactor` (*measured*, GraphicsConfiguration.xml via
  [dxvk #929](https://github.com/doitsujin/dxvk/issues/929)). Fog motes = small drifting
  dust particles near the ship.
- **Visibility inside a ring**: no published km figure. Structure is detailed rocks →
  impostors "in a hazy milk layer" → fog sheet; full-detail field reads **~10–20 km
  across** before dissolving into haze (*eyeballed*).
- **Haze tint follows ring type**: icy = cold blue-white, rocky/metal = warm brown-grey
  (*eyeballed*; type colors *community-estimated*).
- **Sunlight**: single hard sun, zero ambient. God rays through the fog; asteroid
  shadows cast into the fog volume on Ultra. **The dark (planet-shadow) side is
  near-total black** — headlights help "almost nothing", rocks are silhouettes against
  the galaxy; night vision exists *because* of this. Entering the shadow is a gradual
  darkening over the field, not a hard line.
- **Skybox**: Milky Way band + stars are a tunable backdrop; on the lit side the haze
  dominates the view near the plane, sky above/below; on the dark side the skybox is
  all you see.

## 6. Motion feel

- **Ship speeds among the rocks** (*measured*, FDev ship stats): stock max ~200–270 m/s,
  boost 200–460 m/s (engineered ~530). Mining transit ~100–200 m/s; **~15 m/s while
  scooping**. Our `cruiseSpeed = 220 m/s` is already dead-on.
- At 100–200 m/s among 100 m rocks the field feels stately; only boost makes rocks
  visibly stream. **The speed sensation is mostly carried by canopy "space dust" streak
  particles and fog motes, not rock parallax** (*measured* — the dust is a canopy
  projection; mods remove it).
- Rocks: tumble in place, zero relative drift, deterministic positions (see §4).

---

## 7. Target spec table

Scene scale: 1 unit = 1 km. "Ours now" from `src/shared/belt/{field,format}.ts`,
`src/server/field.ts`, `src/client/eve/{lighting.ts,gpu/cull-cpu.ts,gpu/kernels/render-node.ts}`,
`src/client/eve/components/WorldView.tsx`, `beltsim/presets/default.json`.

| Quantity | ED (confidence) | Ours now | Target |
|---|---|---|---|
| Slab full thickness | 2–4 km (*community-est.*) | **180 km** (bake zMax 0.09 × 1e6 worldScale) | ~4 km via shared vertical squash of density sampling (runtime, no re-bake) |
| Rock number density (in-slab) | ~5–40 /km³, central ~5–10 (*derived/community*) | **0.59 /km³ peak** (0.85/cell ÷ 1.13³ km³) | ~4–7 /km³ → cellSize 1130→~565 m (raises the 1-rock-per-cell ceiling 8×) |
| Nearest-neighbour spacing | ≥300 m, feel 150–500 m (*community-est.*) | ~1,100 m | ~350–500 m |
| Dominant rock size (cockpit) | 50–300 m (*eyeballed*) | 55–355 m power law, median 78 m | keep law; widen to ~20–355 m so pebbles read against the big ones |
| Largest rocks | ~1 km common-rare, fixed core meshes (*measured*) | heroes 100–2,150 m | keep (already right) |
| Rock shape | lumpy potato, ~6 meshes/type (*community*) | **platonic solids (dodeca→tetra)** | noise-displaced low-poly rocks, per-instance shape via TSL displacement |
| Rock color/material | rocky: grey-brown matte (*eyeballed*) | flat #6f6a60, rough 0.96 | grey-brown w/ per-instance albedo variation; ring-type palette switchable |
| Tumble rate | 0.02–0.1 rad/s typical, ~0.2–0.6 fast (*eyeballed*) | 0.05–0.30 rad/s | 0.01–0.12 rad/s + rare fast tail |
| Relative rock motion | none (rigid ring) | none (static field + cosmetic wobble) | keep |
| Detailed-rock radius | ~5–10 km (*eyeballed*) | 18 km draw | ~10–11 km draw, LOD bands tightened |
| Impostor/persistence shell | ~20–25 km (*measured*) | far-field speckle + haze beyond derive bubble | keep far-field; tune handoff to ~11 km |
| In-ring visibility (fog) | rocks dissolve into tinted haze ~10–20 km (*eyeballed*) | fog #03040a, 9→18 km | fog ~3.5→11 km, dust-tinted (warm grey for rocky) |
| Lighting | single hard sun, zero ambient, black shadow side | same (ambient 0) | keep; fog tint carries the "dust glow" |
| Ship cruise speed | 200–270 m/s (*measured*) | 220 m/s | keep |
| Visible rocks at once | hundreds–thousands | ~14k in 18 km ball at 0.59/km³ | ~7k in an 11 km ball within a 4 km slab at ~5/km³ |

**Perf sanity for the target column**: a 4 km slab at 5 rocks/km³ inside an 11 km draw
radius is π·11²·4·5 ≈ **7,600 drawn-candidate rocks** (fewer after frustum cull) and
π·20²·4·5 ≈ **25k resident** in a 20 km bubble — under the current
`HAYSTACK_RENDERED_LIMIT` (50k) and comparable to today's resident counts. The thin slab
is what makes ED density affordable.

**Open fork (asked in the DM): icy ring vs rocky ring as the reference look.** Icy is
the iconic bright-sparkle mining footage; rocky is closest to our current palette and
mineral fiction. The plan defaults to **rocky** with the palette isolated so icy is a
constant-swap later.
