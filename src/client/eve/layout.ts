import {
  mobileReservedTop,
  reservedLeft,
  reservedTop,
  titlebarHeight,
  windowDefinitionByKey,
  windowDefinitions,
  windowMargin,
} from "./constants";
import type { LayoutState, WindowDefinition, WindowState } from "./types";

export function createDefaultLayout(): LayoutState {
  const entries = windowDefinitions.map((definition) => [
    definition.key,
    clampWindowState(definition.defaultState, definition),
  ]);
  return Object.fromEntries(entries) as LayoutState;
}

export function layoutKey(pilotId: string): string {
  return `haystack.layout.${pilotId}`;
}

export function loadLayout(pilotId: string): LayoutState {
  const fallback = createDefaultLayout();
  const raw = window.localStorage.getItem(layoutKey(pilotId));
  if (raw === null) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof LayoutState, Partial<WindowState>>>;
    const entries = windowDefinitions.map((definition) => {
      const restored = parsed[definition.key] ?? {};
      const state = {
        ...definition.defaultState,
        ...restored,
      };
      return [definition.key, clampWindowState(sanitizeWindowState(state), definition)];
    });
    return Object.fromEntries(entries) as LayoutState;
  } catch {
    return fallback;
  }
}

export function clampLayout(layout: LayoutState): LayoutState {
  const entries = windowDefinitions.map((definition) => [
    definition.key,
    clampWindowState(layout[definition.key], definition),
  ]);
  return Object.fromEntries(entries) as LayoutState;
}

export function patchWindowState(
  layout: LayoutState,
  key: keyof LayoutState,
  patch: Partial<WindowState>,
): LayoutState {
  return {
    ...layout,
    [key]: clampWindowState(
      {
        ...layout[key],
        ...patch,
      },
      windowDefinitionByKey[key],
    ),
  };
}

export function clampWindowState(state: WindowState, definition: WindowDefinition): WindowState {
  const viewportWidth = window.innerWidth || 1280;
  const viewportHeight = window.innerHeight || 720;
  const topReserved = viewportWidth <= 720 ? mobileReservedTop : reservedTop;
  const maxWidth = Math.max(definition.minWidth, viewportWidth - reservedLeft - windowMargin * 2);
  const width = Math.max(definition.minWidth, Math.min(state.width, maxWidth));
  const maxHeight = Math.max(definition.minHeight, viewportHeight - topReserved - windowMargin);
  const height = Math.max(definition.minHeight, Math.min(state.height, maxHeight));
  const minX = viewportWidth <= 720 ? windowMargin : reservedLeft + windowMargin;
  const maxX = Math.max(minX, viewportWidth - width - windowMargin);
  const x = Math.max(minX, Math.min(state.x, maxX));
  const minY = topReserved;
  const maxY = Math.max(minY, viewportHeight - titlebarHeight - windowMargin);
  const y = Math.max(minY, Math.min(state.y, maxY));
  return { ...state, x, y, width, height };
}

function sanitizeWindowState(state: WindowState): WindowState {
  return {
    x: finiteOr(state.x, 60),
    y: finiteOr(state.y, reservedTop),
    width: finiteOr(state.width, 300),
    height: finiteOr(state.height, 240),
    open: state.open === true,
    minimized: state.minimized === true,
    z: finiteOr(state.z, 1),
  };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
