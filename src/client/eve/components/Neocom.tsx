import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { windowDefinitions } from "../constants";
import type { LayoutState, WindowKey } from "../types";
import { WindowIcon } from "./icons";

export function Neocom({
  layout,
  unreadComms,
  onToggle,
  onReset,
}: {
  layout: LayoutState;
  unreadComms: number;
  onToggle: (key: WindowKey) => void;
  onReset: () => void;
}): ReactNode {
  return (
    <nav className="neocom" data-testid="neocom" aria-label="Window launcher">
      {windowDefinitions.map((definition) => (
        <button
          type="button"
          key={definition.key}
          data-testid={`neocom-${definition.key}`}
          data-open={layout[definition.key].open}
          data-blink={definition.key === "comms" && unreadComms > 0}
          aria-label={`${layout[definition.key].open ? "Close" : "Open"} ${definition.label}`}
          title={definition.label}
          onClick={() => onToggle(definition.key)}
        >
          <WindowIcon windowKey={definition.key} size={18} />
          {definition.key === "comms" && unreadComms > 0 ? <b>{unreadComms}</b> : null}
        </button>
      ))}
      <button
        type="button"
        className="neocom-reset"
        data-testid="layout-reset"
        aria-label="Reset window layout"
        title="Reset layout"
        onClick={onReset}
      >
        <RotateCcw size={17} />
      </button>
    </nav>
  );
}
