import type {
  Asteroid,
  Deposit,
  ScanHit,
  ScanReport,
  Ship,
  Structure,
  Vector3,
  WorldSnapshot,
} from "../../shared/types";
import type { OverviewFilter, OverviewKind, OverviewRow, Selection, SortState } from "./types";
import {
  addVector,
  formatBearing,
  rangeBetween,
  scaleVector,
  subtract,
  surfaceBearing,
  unit,
  vectorMagnitude,
} from "./vector";

// Field-static part of an asteroid overview row. The asteroid field is a pure
// function of the seed, so everything here (id/name/clue/position/signature) is
// constant until the visible *set* changes (a cell crossing). Computing it once
// per cell-cross — memoized on the asteroids array reference — keeps the per-commit
// overview build from re-deriving 50k clue strings + row scaffolds every delta.
export type AsteroidScaffoldRow = {
  key: string;
  id: string;
  name: string;
  clue: string;
  position: Vector3;
  signature: number;
};

export type AsteroidScaffold = {
  // Discovered asteroids in nearest-first order (the derived-field order), so the first
  // entries are the nearest rocks — used for the in-world brackets without a full sort.
  rows: AsteroidScaffoldRow[];
  byKey: Map<string, AsteroidScaffoldRow>;
};

export function buildAsteroidScaffold(asteroids: ReadonlyArray<Asteroid>): AsteroidScaffold {
  const rows: AsteroidScaffoldRow[] = [];
  const byKey = new Map<string, AsteroidScaffoldRow>();
  for (const asteroid of asteroids) {
    if (!asteroid.discovered) {
      continue;
    }
    const row: AsteroidScaffoldRow = {
      key: `asteroid:${asteroid.id}`,
      id: asteroid.id,
      name: asteroid.id,
      clue: `${asteroid.rareMineral} trace, richness ${Math.round(asteroid.mineralRichness * 100)}%`,
      position: asteroid.position,
      signature: asteroid.signature,
    };
    rows.push(row);
    byKey.set(row.key, row);
  }
  return { rows, byKey };
}

export function buildOverviewRows(
  snapshot: WorldSnapshot,
  myShip: Ship,
  pilotId: string,
  latestScan: ScanReport | null,
  // Memoized field-static asteroid rows (see buildAsteroidScaffold). When omitted
  // we derive it inline so non-memoized callers (tests) keep working.
  scaffold: AsteroidScaffold = buildAsteroidScaffold(snapshot.asteroids),
): OverviewRow[] {
  const rows = new Map<string, OverviewRow>();
  // The asteroid field can be up to 100k rocks; building an id->asteroid Map over
  // the whole set every commit was a top trace cost. Only scan-hit position lookups
  // and discovered-deposit position lookups need it, so build it lazily and at most
  // once per call — skipped entirely in the common no-scan / no-deposit case.
  let asteroidsByIdCache: Map<string, Asteroid> | null = null;
  function asteroidsById(): Map<string, Asteroid> {
    if (asteroidsByIdCache === null) {
      asteroidsByIdCache = new Map(snapshot.asteroids.map((asteroid) => [asteroid.id, asteroid]));
    }
    return asteroidsByIdCache;
  }
  const structuresById = new Map(snapshot.structures.map((structure) => [structure.id, structure]));
  const pilotsById = new Map(snapshot.pilots.map((pilot) => [pilot.id, pilot]));
  const shipsByPilot = new Map(snapshot.ships.map((ship) => [ship.pilotId, ship]));

  function add(row: OverviewRow): void {
    rows.set(row.key, { ...rows.get(row.key), ...row });
  }

  if (latestScan !== null) {
    latestScan.hits.forEach((hit) => {
      const position = positionForHit(
        hit,
        latestScan.origin,
        asteroidsById(),
        structuresById,
        shipsByPilot,
      );
      const deposit = hit.kind === "deposit" ? findDeposit(snapshot, hit.id) : undefined;
      add({
        key: `${hit.kind}:${hit.id}`,
        id: hit.id,
        kind: hit.kind,
        name: hit.label,
        distance: hit.distance,
        strength: hit.strength,
        bearing: hit.bearing,
        clue: hit.clue,
        position,
        ...(deposit !== undefined ? { asteroidId: deposit.asteroidId } : {}),
      });
    });
  }

  // Per-commit, only the distance + bearing (which depend on the ship's moving
  // position) are recomputed; the rest comes from the memoized scaffold. This loop
  // runs over the WHOLE discovered field (up to 100k), so it is the dominant source of
  // per-commit garbage. We therefore (a) write straight into the Map instead of the
  // add() spread — for an asteroid key the row fully overwrites any prior scan-hit
  // entry, so the {...prev,...row} merge was a wasted allocation — and (b) inline the
  // distance/bearing math (1 vector allocated, not the 3 that rangeBetween + subtract +
  // unit produced). ~5 objects/row -> 2 objects/row.
  const shipX = myShip.position.x;
  const shipY = myShip.position.y;
  const shipZ = myShip.position.z;
  for (const scaffoldRow of scaffold.rows) {
    const dx = scaffoldRow.position.x - shipX;
    const dy = scaffoldRow.position.y - shipY;
    const dz = scaffoldRow.position.z - shipZ;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const inverse = distance > 0.0001 ? 1 / distance : 0;
    rows.set(scaffoldRow.key, {
      key: scaffoldRow.key,
      id: scaffoldRow.id,
      kind: "asteroid",
      name: scaffoldRow.name,
      distance,
      strength: scaffoldRow.signature,
      bearing: { x: dx * inverse, y: dy * inverse, z: dz * inverse },
      clue: scaffoldRow.clue,
      position: scaffoldRow.position,
    });
  }

  snapshot.deposits
    .filter((deposit) => deposit.discovered)
    .forEach((deposit) => {
      const asteroid = asteroidsById().get(deposit.asteroidId);
      add({
        key: `deposit:${deposit.id}`,
        id: deposit.id,
        kind: "deposit",
        name: `${deposit.mineral} deposit`,
        distance: asteroid === undefined ? 0 : rangeBetween(myShip.position, asteroid.position),
        strength: deposit.abundance,
        bearing: surfaceBearing(deposit.latitude, deposit.longitude),
        clue: `${deposit.remaining.toFixed(1)}t remaining`,
        position: asteroid?.position ?? null,
        asteroidId: deposit.asteroidId,
      });
    });

  snapshot.structures
    .filter(
      (structure) =>
        structure.discovered && (!structure.hidden || structure.ownerPilotId === pilotId),
    )
    .forEach((structure) => {
      add({
        key: `structure:${structure.id}`,
        id: structure.id,
        kind: "structure",
        name: structure.name,
        distance: rangeBetween(myShip.position, structure.position),
        strength: structure.signature,
        bearing: unit(subtract(structure.position, myShip.position)),
        clue: structure.hidden ? `${structure.kind}, hidden` : structure.kind,
        position: structure.position,
      });
    });

  snapshot.ships
    .filter((ship) => ship.pilotId !== pilotId)
    .forEach((ship) => {
      const pilot = pilotsById.get(ship.pilotId);
      add({
        key: `ship:${ship.pilotId}`,
        id: ship.pilotId,
        kind: "ship",
        name: pilot?.callsign ?? ship.name,
        distance: rangeBetween(myShip.position, ship.position),
        strength: 0.74 + ship.heat / 200,
        bearing: unit(subtract(ship.position, myShip.position)),
        clue: `${ship.name}, ${vectorMagnitude(ship.velocity).toFixed(1)}m/s`,
        position: ship.position,
      });
    });

  return [...rows.values()];
}

// A compact, allocation-light overview model. Instead of materializing one OverviewRow
// per discovered asteroid every commit (~5 objects x up to 100k = the dominant GC
// source), it holds:
//   - the memoized asteroid scaffold (field-static, nearest-first),
//   - the small set of fully-materialized dynamic rows (scan hits, deposits, structures,
//     ships) that genuinely change per tick,
//   - a sorted+filtered `order` of integer refs (>=0 = asteroid scaffold index;
//     <0 = dynamic index -(j+1)) — a single packed-int array, no per-row objects,
// and materializes a real OverviewRow ONLY on demand: the ~visible window, the selected
// row, the context/info row, and the in-world bracket rows. Per-commit asteroid garbage
// drops from O(field) objects to a couple of arrays.
export type OverviewModel = {
  scaffold: AsteroidScaffold;
  myShip: Ship;
  dynamicRows: OverviewRow[];
  dynamicByKey: Map<string, OverviewRow>;
  // Sorted + filtered refs. Empty when the order is not needed (overview window closed).
  order: number[];
  total: number;
};

function materializeAsteroidRow(scaffoldRow: AsteroidScaffoldRow, myShip: Ship): OverviewRow {
  const dx = scaffoldRow.position.x - myShip.position.x;
  const dy = scaffoldRow.position.y - myShip.position.y;
  const dz = scaffoldRow.position.z - myShip.position.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const inverse = distance > 0.0001 ? 1 / distance : 0;
  return {
    key: scaffoldRow.key,
    id: scaffoldRow.id,
    kind: "asteroid",
    name: scaffoldRow.name,
    distance,
    strength: scaffoldRow.signature,
    bearing: { x: dx * inverse, y: dy * inverse, z: dz * inverse },
    clue: scaffoldRow.clue,
    position: scaffoldRow.position,
  };
}

// Build the dynamic (non-scaffold) rows exactly as buildOverviewRows would, then drop any
// key the scaffold already covers (an in-field scanned asteroid) — matching the original
// "asteroid loop overwrites the scan-hit row" semantics. Out-of-field scan-hit asteroids
// (not in the derived set) survive as dynamic rows, also matching the original.
function buildDynamicRows(
  snapshot: WorldSnapshot,
  myShip: Ship,
  pilotId: string,
  latestScan: ScanReport | null,
  scaffold: AsteroidScaffold,
): { rows: OverviewRow[]; byKey: Map<string, OverviewRow> } {
  const map = new Map<string, OverviewRow>();
  let asteroidsByIdCache: Map<string, Asteroid> | null = null;
  const asteroidsById = (): Map<string, Asteroid> => {
    if (asteroidsByIdCache === null) {
      asteroidsByIdCache = new Map(snapshot.asteroids.map((asteroid) => [asteroid.id, asteroid]));
    }
    return asteroidsByIdCache;
  };
  const structuresById = new Map(snapshot.structures.map((s) => [s.id, s]));
  const pilotsById = new Map(snapshot.pilots.map((p) => [p.id, p]));
  const shipsByPilot = new Map(snapshot.ships.map((s) => [s.pilotId, s]));
  const add = (row: OverviewRow): void => {
    map.set(row.key, { ...map.get(row.key), ...row });
  };

  if (latestScan !== null) {
    latestScan.hits.forEach((hit) => {
      const position = positionForHit(
        hit,
        latestScan.origin,
        asteroidsById(),
        structuresById,
        shipsByPilot,
      );
      const deposit = hit.kind === "deposit" ? findDeposit(snapshot, hit.id) : undefined;
      add({
        key: `${hit.kind}:${hit.id}`,
        id: hit.id,
        kind: hit.kind,
        name: hit.label,
        distance: hit.distance,
        strength: hit.strength,
        bearing: hit.bearing,
        clue: hit.clue,
        position,
        ...(deposit !== undefined ? { asteroidId: deposit.asteroidId } : {}),
      });
    });
  }

  snapshot.deposits
    .filter((deposit) => deposit.discovered)
    .forEach((deposit) => {
      const asteroid = asteroidsById().get(deposit.asteroidId);
      add({
        key: `deposit:${deposit.id}`,
        id: deposit.id,
        kind: "deposit",
        name: `${deposit.mineral} deposit`,
        distance: asteroid === undefined ? 0 : rangeBetween(myShip.position, asteroid.position),
        strength: deposit.abundance,
        bearing: surfaceBearing(deposit.latitude, deposit.longitude),
        clue: `${deposit.remaining.toFixed(1)}t remaining`,
        position: asteroid?.position ?? null,
        asteroidId: deposit.asteroidId,
      });
    });

  snapshot.structures
    .filter((s) => s.discovered && (!s.hidden || s.ownerPilotId === pilotId))
    .forEach((structure) => {
      add({
        key: `structure:${structure.id}`,
        id: structure.id,
        kind: "structure",
        name: structure.name,
        distance: rangeBetween(myShip.position, structure.position),
        strength: structure.signature,
        bearing: unit(subtract(structure.position, myShip.position)),
        clue: structure.hidden ? `${structure.kind}, hidden` : structure.kind,
        position: structure.position,
      });
    });

  snapshot.ships
    .filter((ship) => ship.pilotId !== pilotId)
    .forEach((ship) => {
      const pilot = pilotsById.get(ship.pilotId);
      add({
        key: `ship:${ship.pilotId}`,
        id: ship.pilotId,
        kind: "ship",
        name: pilot?.callsign ?? ship.name,
        distance: rangeBetween(myShip.position, ship.position),
        strength: 0.74 + ship.heat / 200,
        bearing: unit(subtract(ship.position, myShip.position)),
        clue: `${ship.name}, ${vectorMagnitude(ship.velocity).toFixed(1)}m/s`,
        position: ship.position,
      });
    });

  // Scaffold (in-field asteroids) wins over any same-key scan-hit row.
  for (const key of [...map.keys()]) {
    if (scaffold.byKey.has(key)) {
      map.delete(key);
    }
  }
  return { rows: [...map.values()], byKey: map };
}

function filterAccepts(kind: OverviewKind, filter: OverviewFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "asteroids":
      return kind === "asteroid";
    case "structures":
      return kind === "structure";
    case "ships":
      return kind === "ship";
    case "signals":
      return kind === "pocket" || kind === "deposit";
  }
}

export function buildOverviewModel(
  scaffold: AsteroidScaffold,
  snapshot: WorldSnapshot,
  myShip: Ship,
  pilotId: string,
  latestScan: ScanReport | null,
  filter: OverviewFilter,
  sort: SortState,
  // Only build the sorted `order` (the O(field) index array + sort) when the overview
  // list is actually shown. Selection / context / brackets use byKey lookups + the
  // nearest-first scaffold and do not need it.
  includeOrder: boolean,
): OverviewModel {
  const dynamic = buildDynamicRows(snapshot, myShip, pilotId, latestScan, scaffold);
  const order: number[] = [];
  if (includeOrder) {
    const asteroidVisible = filterAccepts("asteroid", filter);
    const n = scaffold.rows.length;
    // Precompute asteroid distances once (a single typed array, no per-row objects) so the
    // default distance sort comparator is a cheap numeric read.
    const distances = asteroidVisible ? new Float64Array(n) : null;
    if (distances !== null) {
      const sx = myShip.position.x;
      const sy = myShip.position.y;
      const sz = myShip.position.z;
      for (let i = 0; i < n; i += 1) {
        const p = scaffold.rows[i]!.position;
        const dx = p.x - sx;
        const dy = p.y - sy;
        const dz = p.z - sz;
        distances[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
        order.push(i);
      }
    }
    for (let j = 0; j < dynamic.rows.length; j += 1) {
      if (filterAccepts(dynamic.rows[j]!.kind, filter)) {
        order.push(-(j + 1));
      }
    }
    sortOrder(order, sort, scaffold, dynamic.rows, distances, myShip);
  }
  return {
    scaffold,
    myShip,
    dynamicRows: dynamic.rows,
    dynamicByKey: dynamic.byKey,
    order,
    total: order.length,
  };
}

// Sort the packed-int `order` in place to match sortOverviewRows exactly, reading sort
// values via accessors instead of materialized rows.
function sortOrder(
  order: number[],
  sort: SortState,
  scaffold: AsteroidScaffold,
  dynamicRows: OverviewRow[],
  distances: Float64Array | null,
  myShip: Ship,
): void {
  const direction = sort.direction === "asc" ? 1 : -1;
  const dyn = (ref: number): OverviewRow => dynamicRows[-(ref + 1)]!;
  const sca = (ref: number): AsteroidScaffoldRow => scaffold.rows[ref]!;
  const nameOf = (ref: number): string => (ref >= 0 ? sca(ref).name : dyn(ref).name);
  const kindOf = (ref: number): string => (ref >= 0 ? "asteroid" : dyn(ref).kind);
  const distOf = (ref: number): number => (ref >= 0 ? (distances?.[ref] ?? 0) : dyn(ref).distance);
  const strengthOf = (ref: number): number => (ref >= 0 ? sca(ref).signature : dyn(ref).strength);
  const keyOf = (ref: number): string => (ref >= 0 ? sca(ref).key : dyn(ref).key);
  // Bearing depends on ship position; format on demand (bearing sort is rarely used).
  const bearingStrOf = (ref: number): string =>
    formatBearing(ref >= 0 ? materializeAsteroidRow(sca(ref), myShip).bearing : dyn(ref).bearing);

  order.sort((a, b) => {
    let value = 0;
    if (sort.field === "name") {
      value = nameOf(a).localeCompare(nameOf(b));
    } else if (sort.field === "type") {
      value = kindOf(a).localeCompare(kindOf(b));
    } else if (sort.field === "distance") {
      value = distOf(a) - distOf(b);
    } else if (sort.field === "strength") {
      value = strengthOf(a) - strengthOf(b);
    } else {
      value = bearingStrOf(a).localeCompare(bearingStrOf(b));
    }
    return value === 0 ? keyOf(a).localeCompare(keyOf(b)) : value * direction;
  });
}

export function materializeRowAt(model: OverviewModel, orderIndex: number): OverviewRow | null {
  const ref = model.order[orderIndex];
  if (ref === undefined) {
    return null;
  }
  if (ref >= 0) {
    return materializeAsteroidRow(model.scaffold.rows[ref]!, model.myShip);
  }
  return model.dynamicRows[-(ref + 1)] ?? null;
}

export function materializeRowByKey(model: OverviewModel, key: string | null): OverviewRow | null {
  if (key === null) {
    return null;
  }
  const dynamic = model.dynamicByKey.get(key);
  if (dynamic !== undefined) {
    return dynamic;
  }
  const scaffoldRow = model.scaffold.byKey.get(key);
  return scaffoldRow === undefined ? null : materializeAsteroidRow(scaffoldRow, model.myShip);
}

// Nearest positioned rows for the in-world brackets — independent of the overview filter
// (the brackets always show what is physically nearby). The scaffold is nearest-first, so
// we only need to consider its head plus the (few) positioned dynamic rows.
export function nearestPositionedRows(model: OverviewModel, max: number): OverviewRow[] {
  const candidates: OverviewRow[] = [];
  const head = Math.min(model.scaffold.rows.length, max * 2);
  for (let i = 0; i < head; i += 1) {
    candidates.push(materializeAsteroidRow(model.scaffold.rows[i]!, model.myShip));
  }
  for (const row of model.dynamicRows) {
    if (row.position !== null) {
      candidates.push(row);
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates.slice(0, max);
}

export function filterOverviewRows(rows: OverviewRow[], filter: OverviewFilter): OverviewRow[] {
  switch (filter) {
    case "all":
      return rows;
    case "asteroids":
      return rows.filter((row) => row.kind === "asteroid");
    case "structures":
      return rows.filter((row) => row.kind === "structure");
    case "ships":
      return rows.filter((row) => row.kind === "ship");
    case "signals":
      return rows.filter((row) => row.kind === "pocket" || row.kind === "deposit");
  }
}

export function sortOverviewRows(rows: OverviewRow[], sort: SortState): OverviewRow[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let value = 0;
    if (sort.field === "name") {
      value = left.name.localeCompare(right.name);
    } else if (sort.field === "type") {
      value = left.kind.localeCompare(right.kind);
    } else if (sort.field === "distance") {
      value = left.distance - right.distance;
    } else if (sort.field === "strength") {
      value = left.strength - right.strength;
    } else {
      value = formatBearing(left.bearing).localeCompare(formatBearing(right.bearing));
    }
    return value === 0 ? left.key.localeCompare(right.key) : value * direction;
  });
}

export function selectedStats(row: OverviewRow, snapshot: WorldSnapshot): Array<[string, string]> {
  if (row.kind === "asteroid") {
    const asteroid = snapshot.asteroids.find((candidate) => candidate.id === row.id);
    return asteroid === undefined
      ? [["signal", `${Math.round(row.strength * 100)}%`]]
      : [
          ["signature", asteroid.signature.toFixed(2)],
          ["richness", `${Math.round(asteroid.mineralRichness * 100)}%`],
          ["rare", asteroid.rareMineral],
        ];
  }
  if (row.kind === "deposit") {
    const deposit = snapshot.deposits.find((candidate) => candidate.id === row.id);
    return deposit === undefined
      ? [["remaining", row.clue]]
      : [
          ["mineral", deposit.mineral],
          ["remaining", `${deposit.remaining.toFixed(1)}t`],
          ["abundance", `${Math.round(deposit.abundance * 100)}%`],
        ];
  }
  if (row.kind === "structure") {
    const structure = snapshot.structures.find((candidate) => candidate.id === row.id);
    return structure === undefined
      ? [["signal", row.clue]]
      : [
          ["kind", structure.kind],
          ["owner", structure.ownerPilotId ?? "unowned"],
          ["hidden", structure.hidden ? "yes" : "no"],
        ];
  }
  if (row.kind === "ship") {
    const pilot = snapshot.pilots.find((candidate) => candidate.id === row.id);
    const ship = snapshot.ships.find((candidate) => candidate.pilotId === row.id);
    return [
      ["callsign", pilot?.callsign ?? row.name],
      ["organization", pilot?.organization ?? "unknown"],
      [
        "velocity",
        ship === undefined ? "unknown" : `${vectorMagnitude(ship.velocity).toFixed(1)}m/s`,
      ],
    ];
  }
  return [["signal", row.clue]];
}

export function sameSelection(left: Selection, right: Selection): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export function kindLabel(kind: OverviewKind): string {
  switch (kind) {
    case "asteroid":
      return "Asteroid";
    case "deposit":
      return "Deposit";
    case "pocket":
      return "Signal";
    case "ship":
      return "Ship";
    case "structure":
      return "Structure";
  }
}

function positionForHit(
  hit: ScanHit,
  origin: { x: number; y: number; z: number },
  asteroids: Map<string, Asteroid>,
  structures: Map<string, Structure>,
  ships: Map<string, Ship>,
): { x: number; y: number; z: number } | null {
  if (hit.kind === "asteroid") {
    return (
      asteroids.get(hit.id)?.position ?? addVector(origin, scaleVector(hit.bearing, hit.distance))
    );
  }
  if (hit.kind === "structure") {
    return (
      structures.get(hit.id)?.position ?? addVector(origin, scaleVector(hit.bearing, hit.distance))
    );
  }
  if (hit.kind === "ship") {
    return ships.get(hit.id)?.position ?? addVector(origin, scaleVector(hit.bearing, hit.distance));
  }
  if (hit.kind === "deposit") {
    return addVector(origin, scaleVector(hit.bearing, Math.min(hit.distance, 1200)));
  }
  return addVector(origin, scaleVector(hit.bearing, hit.distance));
}

function findDeposit(snapshot: WorldSnapshot, depositId: string): Deposit | undefined {
  return snapshot.deposits.find((deposit) => deposit.id === depositId);
}
