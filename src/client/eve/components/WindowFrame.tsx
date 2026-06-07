import { Minus, X } from "lucide-react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { titlebarHeight } from "../constants";
import type { WindowDefinition, WindowState } from "../types";
import { WindowIcon } from "./icons";

export function WindowFrame({
  definition,
  state,
  focused,
  children,
  onFocus,
  onPatch,
  onClose,
}: {
  definition: WindowDefinition;
  state: WindowState;
  focused: boolean;
  children: ReactNode;
  onFocus: () => void;
  onPatch: (patch: Partial<WindowState>) => void;
  onClose: () => void;
}): ReactNode {
  const height = state.minimized ? titlebarHeight : state.height;
  const style = {
    left: state.x,
    top: state.y,
    width: state.width,
    height,
    zIndex: 100 + state.z,
  } satisfies CSSProperties;

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    onFocus();
    const start = { x: event.clientX, y: event.clientY, state };
    const move = (nextEvent: globalThis.PointerEvent): void => {
      onPatch({
        x: start.state.x + nextEvent.clientX - start.x,
        y: start.state.y + nextEvent.clientY - start.y,
      });
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function beginResize(direction: string, event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    const start = { x: event.clientX, y: event.clientY, state };
    const move = (nextEvent: globalThis.PointerEvent): void => {
      const dx = nextEvent.clientX - start.x;
      const dy = nextEvent.clientY - start.y;
      const patch: Partial<WindowState> = {};
      if (direction.includes("e")) {
        patch.width = start.state.width + dx;
      }
      if (direction.includes("s")) {
        patch.height = start.state.height + dy;
      }
      if (direction.includes("w")) {
        patch.x = start.state.x + dx;
        patch.width = start.state.width - dx;
      }
      if (direction.includes("n")) {
        patch.y = start.state.y + dy;
        patch.height = start.state.height - dy;
      }
      onPatch(patch);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <section
      className="window-frame"
      style={style}
      data-testid={`window-${definition.key}`}
      data-focused={focused}
      data-minimized={state.minimized}
      data-z={state.z}
      data-min-width={definition.minWidth}
      data-min-height={definition.minHeight}
      onPointerDown={onFocus}
    >
      <div
        className="window-titlebar"
        data-testid={`window-${definition.key}-titlebar`}
        onPointerDown={beginDrag}
        onDoubleClick={() => onPatch({ minimized: !state.minimized })}
      >
        <span className="window-title">
          <span data-testid={`window-${definition.key}-icon`}>
            <WindowIcon windowKey={definition.key} size={15} />
          </span>
          <span data-testid={`window-${definition.key}-label`}>{definition.label}</span>
        </span>
        <span className="window-controls" data-testid={`window-${definition.key}-controls`}>
          <button
            type="button"
            data-testid={`window-${definition.key}-minimize`}
            className="winctl"
            aria-label={`${state.minimized ? "Restore" : "Minimize"} ${definition.label}`}
            title={state.minimized ? "Restore" : "Minimize"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onPatch({ minimized: !state.minimized })}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            data-testid={`window-${definition.key}-close`}
            className="winctl"
            aria-label={`Close ${definition.label}`}
            title="Close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </span>
      </div>
      {!state.minimized ? (
        <div className="window-body" data-testid={`window-${definition.key}-body`}>
          {children}
        </div>
      ) : null}
      {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map((direction) => (
        <div
          key={direction}
          className={`resize-handle resize-${direction}`}
          data-testid={`window-${definition.key}-resize-${direction}`}
          onPointerDown={(event) => beginResize(direction, event)}
        />
      ))}
    </section>
  );
}
