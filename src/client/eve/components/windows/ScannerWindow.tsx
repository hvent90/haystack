import { Radio } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScanMode } from "../../../../shared/types";
import { scannerModes } from "../../constants";
import { kindLabel, materializeRowAt, type OverviewModel } from "../../overview";
import type { OverviewFilter, OverviewRow, Selection, SortField, SortState } from "../../types";
import { formatBearing, formatDistance } from "../../vector";

// Approximate rendered height of one overview <tr> (px). Self-corrected at runtime from
// the first real row's measured height, so a CSS tweak can't silently break the math.
const DEFAULT_ROW_HEIGHT = 27;
// Extra rows rendered above/below the viewport so a fast scroll never shows blank gaps.
const OVERSCAN = 8;

export function ScannerWindow({
  model,
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
  model: OverviewModel | null;
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
  // Virtualize the overview: the EVE overview lists every discovered rock, which is the
  // full derived field (up to 100k rows). Rendering one <tr> per row tanked the main
  // thread (rebuilt + re-diffed every world commit). We render only the rows inside the
  // scroll viewport (+overscan) and pad the rest with spacer <tr>s so the scrollbar and
  // row positions stay correct, while the DOM holds only a few dozen rows.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const firstRowRef = useRef<HTMLTableRowElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);

  useEffect(() => {
    const element = wrapRef.current;
    if (element === null) {
      return undefined;
    }
    const measure = (): void => setViewportHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Re-anchor to the top of the list whenever the result set is re-ordered or re-filtered
  // so the visible window always starts at the nearest (sorted-first) rows — and so the
  // e2e distance-sort check, which reads the rendered rows top-down, sees them in order.
  useEffect(() => {
    const element = wrapRef.current;
    if (element !== null) {
      element.scrollTop = 0;
    }
    setScrollTop(0);
  }, [filter, sort]);

  // Self-correct the row height from the first rendered row (CSS-resilient).
  useLayoutEffect(() => {
    const element = firstRowRef.current;
    if (element !== null && element.offsetHeight > 0 && element.offsetHeight !== rowHeight) {
      setRowHeight(element.offsetHeight);
    }
  });

  const total = model?.total ?? 0;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN);
  // Materialize ONLY the visible window of rows on demand from the compact model.
  const windowRows: OverviewRow[] = [];
  if (model !== null) {
    for (let i = start; i < end; i += 1) {
      const row = materializeRowAt(model, i);
      if (row !== null) {
        windowRows.push(row);
      }
    }
  }
  const topPad = start * rowHeight;
  const bottomPad = Math.max(0, (total - end) * rowHeight);

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
      <div
        className="overview-table-wrap"
        data-loading={loading}
        ref={wrapRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
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
            {topPad > 0 ? (
              <tr aria-hidden="true" className="overview-spacer">
                <td colSpan={5} style={{ height: topPad, padding: 0, border: 0 }} />
              </tr>
            ) : null}
            {windowRows.map((row, index) => (
              <tr
                key={row.key}
                ref={index === 0 ? firstRowRef : undefined}
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
            {bottomPad > 0 ? (
              <tr aria-hidden="true" className="overview-spacer">
                <td colSpan={5} style={{ height: bottomPad, padding: 0, border: 0 }} />
              </tr>
            ) : null}
          </tbody>
        </table>
        {total === 0 && !loading ? (
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
