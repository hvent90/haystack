import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { WorldSnapshot } from "../../../shared/types";
import { kindLabel, sameSelection } from "../overview";
import type { OverviewRow, Selection } from "../types";
import { formatDistance } from "../vector";

export function ShowInfoCard({
  target,
  snapshot,
  rows,
  onClose,
}: {
  target: Selection;
  snapshot: WorldSnapshot;
  rows: OverviewRow[];
  onClose: () => void;
}): ReactNode {
  const row = rows.find((candidate) => sameSelection(candidate, target));
  const pilot =
    target.kind === "ship" ? snapshot.pilots.find((candidate) => candidate.id === target.id) : null;
  return (
    <section className="show-info-card" data-testid="showinfo-card">
      <div className="show-info-title">
        <b data-testid="show-info-card">{pilot?.callsign ?? row?.name ?? target.id}</b>
        <button
          type="button"
          data-testid="showinfo-close"
          aria-label="Close show info"
          title="Close"
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </div>
      <div className="show-info-body">
        {pilot !== null && pilot !== undefined ? (
          <>
            <span>{pilot.organization}</span>
            <span>{pilot.shipName}</span>
            <span>
              {pilot.cargoMass.toFixed(1)} / {pilot.cargoCapacity}t
            </span>
            <span>{pilot.scanPower.toFixed(2)} scan</span>
            <span>{pilot.miningPower.toFixed(1)} mining</span>
          </>
        ) : row !== undefined ? (
          <>
            <span>{kindLabel(row.kind)}</span>
            <span>{row.id}</span>
            <span>{formatDistance(row.distance)}</span>
            <span>{Math.round(row.strength * 100)}% signal</span>
            <span>{row.clue}</span>
          </>
        ) : (
          <span>{target.id}</span>
        )}
      </div>
    </section>
  );
}
