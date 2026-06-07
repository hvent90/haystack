export function isFlightKey(code: string): boolean {
  return (
    code === "KeyW" ||
    code === "KeyQ" ||
    code === "KeyE" ||
    code === "KeyA" ||
    code === "KeyS" ||
    code === "KeyD" ||
    code === "KeyZ" ||
    code === "KeyC" ||
    code === "Space" ||
    code === "ControlLeft" ||
    code === "ControlRight" ||
    code === "KeyX" ||
    code === "KeyJ" ||
    code === "Tab"
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}
