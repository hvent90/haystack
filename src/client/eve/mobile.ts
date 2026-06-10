// Touch-device detection for the mobile control scheme + UI fit.
//
// CAPABILITY detection, not user-agent sniffing: the touch UI activates when the device
// reports touch points and exposes no fine pointer (mouse/trackpad). A convertible
// laptop with both keeps the desktop scheme — its trackpad flies fine, and pointer lock
// works there. `?touch=1` / `?touch=0` overrides the probe for e2e harnesses and
// desktop debugging (capability emulation in headless browsers is inconsistent).
//
// The result is cached: the control scheme must not flip mid-session (a `resize` or a
// `matchMedia` flicker while flying would tear down the stick the thumb is holding).

let cached: boolean | null = null;

export function isTouchDevice(): boolean {
  if (cached === null) {
    cached = detectTouchDevice();
  }
  return cached;
}

function detectTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const override = new URLSearchParams(window.location.search).get("touch");
  if (override === "1") {
    return true;
  }
  if (override === "0") {
    return false;
  }
  const hasTouch = (navigator.maxTouchPoints ?? 0) > 0;
  const hasFinePointer = window.matchMedia?.("(any-pointer: fine)")?.matches ?? false;
  return hasTouch && !hasFinePointer;
}

// Test seam: lets unit tests re-run detection under different mocked environments.
export function resetTouchDeviceCacheForTests(): void {
  cached = null;
}
