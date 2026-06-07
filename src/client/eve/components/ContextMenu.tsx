import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { ContextMenuState, OverviewRow, Selection } from "../types";

export function ContextMenu({
  state,
  row,
  markerActive,
  onClose,
  onSelect,
  onShowInfo,
  onScan,
  onMine,
  onSetMarker,
  onClearSelection,
  onClearMarker,
  onDeployBase,
  onPulseScan,
  onOpenDm,
  onInspectBase,
}: {
  state: ContextMenuState;
  row: OverviewRow | null;
  markerActive: boolean;
  onClose: () => void;
  onSelect: (target: Selection) => void;
  onShowInfo: (target: Selection) => void;
  onScan: (row: OverviewRow) => void;
  onMine: () => void;
  onSetMarker: (row: OverviewRow) => void;
  onClearSelection: () => void;
  onClearMarker: () => void;
  onDeployBase: () => void;
  onPulseScan: () => void;
  onOpenDm: (target: Selection) => void;
  onInspectBase: () => void;
}): ReactNode {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = menuRef.current?.querySelector("button");
    if (first instanceof HTMLButtonElement) {
      first.focus();
    }
  }, []);

  function activate(callback: () => void): void {
    callback();
    onClose();
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const buttons = [...(menuRef.current?.querySelectorAll("button") ?? [])];
    const index = buttons.findIndex((button) => button === document.activeElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const next = buttons[(index + offset + buttons.length) % buttons.length];
    next?.focus();
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      data-testid="context-menu"
      style={{ left: state.x, top: state.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={keyDown}
    >
      {row === null ? (
        <>
          <button
            type="button"
            data-testid="context-item-deploy-base"
            onClick={() => activate(onDeployBase)}
          >
            Deploy Base here
          </button>
          <button
            type="button"
            data-testid="context-item-pulse-scan"
            onClick={() => activate(onPulseScan)}
          >
            Pulse Scan
          </button>
          <button
            type="button"
            data-testid="context-item-clear-selection"
            onClick={() => activate(onClearSelection)}
          >
            Clear selection
          </button>
          {markerActive ? (
            <button
              type="button"
              data-testid="context-item-clear-marker"
              onClick={() => activate(onClearMarker)}
            >
              Clear marker
            </button>
          ) : null}
        </>
      ) : (
        <>
          <button
            type="button"
            data-testid="context-item-select"
            onClick={() => activate(() => onSelect(row))}
          >
            Select
          </button>
          <button
            type="button"
            data-testid="context-item-show-info"
            onClick={() => activate(() => onShowInfo(row))}
          >
            Show Info
          </button>
          {row.kind === "asteroid" ? (
            <button
              type="button"
              data-testid="context-item-scan"
              onClick={() => activate(() => onScan(row))}
            >
              Scan this target
            </button>
          ) : null}
          {row.kind === "deposit" ? (
            <button type="button" data-testid="context-item-mine" onClick={() => activate(onMine)}>
              Mine deposit
            </button>
          ) : null}
          {row.kind === "ship" ? (
            <button
              type="button"
              data-testid="context-item-open-dm"
              onClick={() => activate(() => onOpenDm(row))}
            >
              Open DM
            </button>
          ) : null}
          {row.kind === "structure" ? (
            <button
              type="button"
              data-testid="context-item-inspect-base"
              onClick={() => activate(onInspectBase)}
            >
              Inspect Base
            </button>
          ) : null}
          {row.position !== null ? (
            <button
              type="button"
              data-testid="context-item-set-marker"
              onClick={() => activate(() => onSetMarker(row))}
            >
              Set waypoint marker
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
