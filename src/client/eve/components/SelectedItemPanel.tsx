import { Info } from "lucide-react";
import type { ReactNode } from "react";
import type { WorldSnapshot } from "../../../shared/types";
import { kindLabel, selectedStats } from "../overview";
import type { OverviewRow } from "../types";
import { formatDistance } from "../vector";

export function SelectedItemPanel({
  row,
  snapshot,
  markerActive,
  onShowInfo,
  onScan,
  onMine,
  onSetFocus,
  onSetMarker,
  onClearMarker,
  onInspectBase,
}: {
  row: OverviewRow | null;
  snapshot: WorldSnapshot;
  markerActive: boolean;
  onShowInfo: () => void;
  onScan: () => void;
  onMine: () => void;
  onSetFocus: () => void;
  onSetMarker: () => void;
  onClearMarker: () => void;
  onInspectBase: () => void;
}): ReactNode {
  const stats = row === null ? [] : selectedStats(row, snapshot);
  return (
    <aside className="selected-item" data-testid="selected-item">
      <div className="selected-header">
        <b data-testid="selected-item-name">{row?.name ?? "No selection"}</b>
        <span data-testid="selected-item-type">{row === null ? "" : kindLabel(row.kind)}</span>
      </div>
      <div data-testid="selected-item-distance">
        {row === null ? "" : formatDistance(row.distance)}
      </div>
      <div className="selected-stats">
        {stats.map(([key, value]) => (
          <span key={key} data-testid={`selected-item-stat-${key}`}>
            <b>{key}</b>
            {value}
          </span>
        ))}
      </div>
      <div className="selected-actions">
        {row !== null ? (
          <>
            <button type="button" data-testid="action-show-info" onClick={onShowInfo}>
              <Info size={13} />
              Show Info
            </button>
            {row.kind === "asteroid" ? (
              <>
                <button type="button" data-testid="action-scan" onClick={onScan}>
                  Scan
                </button>
                <button type="button" data-testid="action-set-focus" onClick={onSetFocus}>
                  Scan Focus
                </button>
              </>
            ) : null}
            {row.kind === "deposit" ? (
              <button type="button" data-testid="action-mine" onClick={onMine}>
                Mine
              </button>
            ) : null}
            {row.kind === "structure" ? (
              <button type="button" data-testid="action-inspect-base" onClick={onInspectBase}>
                Inspect Base
              </button>
            ) : null}
            {row.position !== null ? (
              <button type="button" data-testid="action-set-marker" onClick={onSetMarker}>
                Set waypoint marker
              </button>
            ) : null}
          </>
        ) : null}
        {markerActive ? (
          <button type="button" data-testid="action-clear-marker" onClick={onClearMarker}>
            Clear marker
          </button>
        ) : null}
      </div>
    </aside>
  );
}
