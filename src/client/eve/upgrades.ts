import type { Ship, UpgradeSystem } from "../../shared/types";

export function upgradeCostEstimate(ship: Ship, system: UpgradeSystem): number {
  switch (system) {
    case "cargo":
      return Math.round(300 + Math.max(0, ship.cargoCapacity - 180) * 2.2);
    case "scanner":
      return Math.round(420 * ship.scanPower);
    case "mining":
      return Math.round(360 + Math.max(0, ship.miningPower - 22) * 24);
    case "stabilizer":
      return Math.round(280 + ship.stabilizerEfficiency * 600);
  }
}

export function upgradeEffect(system: UpgradeSystem): string {
  switch (system) {
    case "cargo":
      return "+60t hold";
    case "scanner":
      return "+0.28 scan";
    case "mining":
      return "+6t yield";
    case "stabilizer":
      return "+8% damping";
  }
}
