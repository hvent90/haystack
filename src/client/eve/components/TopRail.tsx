import {
  Box,
  CircleDollarSign,
  Gauge,
  House,
  MousePointer2,
  Rocket,
  Ship as ShipIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Ship, WorldSnapshot } from "../../../shared/types";
import type { FlightMode } from "../types";
import { meters } from "../vector";

export function TopRail({
  snapshot,
  myShip,
  flightMode,
  throttle,
  cruiseLock,
  error,
}: {
  snapshot: WorldSnapshot;
  myShip: Ship;
  flightMode: FlightMode;
  throttle: number;
  cruiseLock: boolean;
  error: string | null;
}): ReactNode {
  return (
    <div className="top-rail" data-testid="top-rail">
      <div className="brand">Haystack</div>
      <RailMetric id="heat" icon={<Gauge size={15} />} value={`${myShip.heat.toFixed(1)} heat`} />
      <RailMetric
        id="cargo"
        icon={<Box size={15} />}
        value={`${myShip.cargoMass.toFixed(1)} / ${myShip.cargoCapacity}t`}
      />
      <RailMetric
        id="credits"
        icon={<CircleDollarSign size={15} />}
        value={`${snapshot.me?.credits.toFixed(0) ?? "0"} cr`}
      />
      <RailMetric
        id="field"
        icon={<House size={15} />}
        value={`${snapshot.field.totalAsteroids.toLocaleString()} indexed`}
      />
      <RailMetric id="position" icon={<ShipIcon size={15} />} value={meters(myShip.position)} />
      <RailMetric id="flight-mode" icon={<MousePointer2 size={15} />} value={flightMode} />
      <RailMetric
        id="throttle"
        icon={<Rocket size={15} />}
        value={`${(throttle * 100).toFixed(0)}% ${cruiseLock ? "CRZ" : "MAN"}`}
      />
      {error !== null ? (
        <div className="error-pill" data-testid="error-pill">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function RailMetric({
  id,
  icon,
  value,
}: {
  id: string;
  icon: ReactNode;
  value: string;
}): ReactNode {
  return (
    <div className="rail-metric" data-testid={`rail-metric-${id}`}>
      {icon}
      <span>{value}</span>
    </div>
  );
}
