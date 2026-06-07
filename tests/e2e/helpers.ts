import type { Page } from "playwright";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 8000,
  stepMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (ok(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("pollUntil timed out");
    }
    await Bun.sleep(stepMs);
  }
}

export async function count(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

export function captureTraffic(page: Page): {
  inputFrames: () => unknown[];
  requests: { url: string; body: string | null }[];
} {
  const wsSent: string[] = [];
  const requests: { url: string; body: string | null }[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => wsSent.push(String(frame.payload)));
  });
  page.on("request", (request) => {
    if (/\/api\/ships\/[^/]+\/(scan|mine|thrust)/.test(request.url())) {
      requests.push({ url: request.url(), body: request.postData() });
    }
  });
  return {
    inputFrames: () =>
      wsSent
        .map((payload) => {
          try {
            return JSON.parse(payload) as { type?: string };
          } catch {
            return {};
          }
        })
        .filter((message) => message.type === "input"),
    requests,
  };
}
