import type {
  Asteroid,
  Deposit,
  ScanHit,
  ScanReport,
  Ship,
  Structure,
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

export function buildOverviewRows(
  snapshot: WorldSnapshot,
  myShip: Ship,
  pilotId: string,
  latestScan: ScanReport | null,
): OverviewRow[] {
  const rows = new Map<string, OverviewRow>();
  const asteroidsById = new Map(snapshot.asteroids.map((asteroid) => [asteroid.id, asteroid]));
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
        asteroidsById,
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

  snapshot.asteroids
    .filter((asteroid) => asteroid.discovered)
    .forEach((asteroid) => {
      add({
        key: `asteroid:${asteroid.id}`,
        id: asteroid.id,
        kind: "asteroid",
        name: asteroid.id,
        distance: rangeBetween(myShip.position, asteroid.position),
        strength: asteroid.signature,
        bearing: unit(subtract(asteroid.position, myShip.position)),
        clue: `${asteroid.rareMineral} trace, richness ${Math.round(asteroid.mineralRichness * 100)}%`,
        position: asteroid.position,
      });
    });

  snapshot.deposits
    .filter((deposit) => deposit.discovered)
    .forEach((deposit) => {
      const asteroid = asteroidsById.get(deposit.asteroidId);
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
