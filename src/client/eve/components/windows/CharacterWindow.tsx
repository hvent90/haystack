import type { ReactNode } from "react";
import type { CharacterCard, Ship, WorldSnapshot } from "../../../../shared/types";
import type { Selection } from "../../types";
import { rangeBetween, vectorMagnitude } from "../../vector";

export function CharacterWindow({
  snapshot,
  me,
  myShip,
  onShowInfo,
}: {
  snapshot: WorldSnapshot;
  me: CharacterCard;
  myShip: Ship;
  onShowInfo: (target: Selection) => void;
}): ReactNode {
  return (
    <div className="cards-list">
      {snapshot.pilots.map((pilot) => {
        const cardShip = snapshot.ships.find((ship) => ship.pilotId === pilot.id);
        const range = cardShip === undefined ? 0 : rangeBetween(myShip.position, cardShip.position);
        const shipTelemetry =
          cardShip === undefined
            ? pilot.shipName
            : `${Math.round(range)}m ${vectorMagnitude(cardShip.velocity).toFixed(1)}m/s`;
        return (
          <button
            type="button"
            key={pilot.id}
            className={pilot.id === me.id ? "pilot-card me" : "pilot-card"}
            data-testid={`card-row-${pilot.id}`}
            data-range-m={range}
            onClick={() => onShowInfo({ kind: "ship", id: pilot.id })}
          >
            <span>
              <strong>{pilot.callsign}</strong>
              <small data-testid={pilot.id === me.id ? "character-card-org" : undefined}>
                {pilot.organization}
              </small>
            </span>
            <b>{shipTelemetry}</b>
          </button>
        );
      })}
    </div>
  );
}
