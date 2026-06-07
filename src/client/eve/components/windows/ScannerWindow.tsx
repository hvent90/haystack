import { Radio } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ScanMode } from "../../../../shared/types";
import { scannerModes } from "../../constants";
import { kindLabel } from "../../overview";
import type { OverviewFilter, OverviewRow, Selection, SortField, SortState } from "../../types";
import { formatBearing, formatDistance } from "../../vector";

export function ScannerWindow({
  rows,
  selected,
  sort,
  filter,
  scanMode,
  loading,
  onSort,
  onFilter,
  onScanMode,
  onScan,
  onSelect,
  onContextMenu,
}: {
  rows: OverviewRow[];
  selected: Selection | null;
  sort: SortState;
  filter: OverviewFilter;
  scanMode: ScanMode;
  loading: boolean;
  onSort: (field: SortField) => void;
  onFilter: (filter: OverviewFilter) => void;
  onScanMode: (mode: ScanMode) => void;
  onScan: () => void;
  onSelect: (selection: Selection) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, target: Selection | null) => void;
}): ReactNode {
  return (
    <>
      <div className="segmented">
        {scannerModes.map((mode) => (
          <button
            type="button"
            key={mode}
            id={mode === scanMode ? "scanner-mode-select" : undefined}
            data-active={mode === scanMode}
            aria-pressed={mode === scanMode}
            onClick={() => onScanMode(mode)}
          >
            {mode}
          </button>
        ))}
        <button
          type="button"
          className="primary-command"
          data-testid="scanner-pulse"
          data-busy={loading}
          aria-busy={loading}
          onClick={onScan}
        >
          <Radio size={14} />
          Pulse
        </button>
      </div>
      <div className="overview-filters">
        {(["all", "asteroids", "structures", "ships", "signals"] as const).map((nextFilter) => (
          <button
            type="button"
            key={nextFilter}
            data-testid={`overview-filter-${nextFilter}`}
            data-active={filter === nextFilter}
            onClick={() => onFilter(nextFilter)}
          >
            {nextFilter}
          </button>
        ))}
      </div>
      <div className="overview-table-wrap" data-loading={loading}>
        {loading ? (
          <div className="loading" data-loading="true">
            scanning
          </div>
        ) : null}
        <table className="overview-table">
          <thead>
            <tr>
              <OverviewHeader field="type" label="Type" sort={sort} onSort={onSort} />
              <OverviewHeader field="name" label="Name" sort={sort} onSort={onSort} />
              <OverviewHeader field="distance" label="Distance" sort={sort} onSort={onSort} />
              <OverviewHeader field="strength" label="Signal" sort={sort} onSort={onSort} />
              <OverviewHeader field="bearing" label="Bearing" sort={sort} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                tabIndex={0}
                data-testid="overview-row"
                data-object-id={row.id}
                data-object-kind={row.kind}
                data-selected={
                  selected !== null && selected.kind === row.kind && selected.id === row.id
                }
                onClick={() => onSelect(row)}
                onKeyDown={(event) => event.key === "Enter" && onSelect(row)}
                onContextMenu={(event) => onContextMenu(event, row)}
              >
                <td data-testid="overview-cell-type">{kindLabel(row.kind)}</td>
                <td data-testid="overview-cell-name">{row.name}</td>
                <td data-testid="overview-cell-distance" data-distance-m={row.distance}>
                  {formatDistance(row.distance)}
                </td>
                <td data-testid="overview-cell-strength">{Math.round(row.strength * 100)}%</td>
                <td data-testid="overview-cell-bearing">{formatBearing(row.bearing)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !loading ? (
          <div className="empty" data-testid="overview-empty">
            no returns
          </div>
        ) : null}
      </div>
    </>
  );
}

function OverviewHeader({
  field,
  label,
  sort,
  onSort,
}: {
  field: SortField;
  label: string;
  sort: SortState;
  onSort: (field: SortField) => void;
}): ReactNode {
  const active = sort.field === field;
  return (
    <th>
      <button
        type="button"
        data-testid={`overview-col-${field}`}
        data-sort-dir={active ? sort.direction : ""}
        aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
        onClick={() => onSort(field)}
      >
        {label}
      </button>
    </th>
  );
}
