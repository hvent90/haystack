import type {
  ChatMessage,
  ChatRequest,
  BuildBaseRequest,
  BuildBaseResult,
  CreatePilotRequest,
  FieldDiagnostic,
  MineRequest,
  MineResult,
  Pilot,
  ScanReport,
  ScanRequest,
  SellRequest,
  SellResult,
  Ship,
  ThrustCommand,
  UpgradeRequest,
  UpgradeResult,
  WorldStreamClientMessage,
  WorldStreamServerMessage,
  WorldSnapshot,
} from "../shared/types";

const apiBase = import.meta.env["VITE_API_URL"] ?? "";

export type Session = {
  pilot: Pilot;
  snapshot: WorldSnapshot;
};

export async function createPilot(request: CreatePilotRequest): Promise<Session> {
  return requestJson<Session>("/api/pilots", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function getPilot(pilotId: string): Promise<Pilot | null> {
  const response = await fetch(`${apiBase}/api/pilots/${encodeURIComponent(pilotId)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const payload = (await response.json()) as { pilot: Pilot };
  return payload.pilot;
}

export async function getWorld(pilotId: string): Promise<WorldSnapshot> {
  const query = new URLSearchParams({ pilotId });
  return requestJson<WorldSnapshot>(`/api/world?${query.toString()}`);
}

export async function sendThrust(pilotId: string, command: ThrustCommand): Promise<Ship> {
  const payload = await requestJson<{ ship: Ship }>(
    `/api/ships/${encodeURIComponent(pilotId)}/thrust`,
    {
      method: "POST",
      body: JSON.stringify(command),
    },
  );
  return payload.ship;
}

export async function pulseScan(pilotId: string, request: ScanRequest): Promise<ScanReport> {
  const payload = await requestJson<{ report: ScanReport }>(
    `/api/ships/${encodeURIComponent(pilotId)}/scan`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  return payload.report;
}

export async function mine(pilotId: string, request: MineRequest): Promise<MineResult> {
  const payload = await requestJson<{ result: MineResult }>(
    `/api/ships/${encodeURIComponent(pilotId)}/mine`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  return payload.result;
}

export async function sellCargo(pilotId: string, request: SellRequest): Promise<SellResult> {
  const payload = await requestJson<{ result: SellResult }>(
    `/api/ships/${encodeURIComponent(pilotId)}/sell`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  return payload.result;
}

export async function buildBase(
  pilotId: string,
  request: BuildBaseRequest,
): Promise<BuildBaseResult> {
  const payload = await requestJson<{ result: BuildBaseResult }>(
    `/api/ships/${encodeURIComponent(pilotId)}/bases`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  return payload.result;
}

export async function fieldDiagnostic(pilotId: string): Promise<FieldDiagnostic> {
  const payload = await requestJson<{ diagnostic: FieldDiagnostic }>(
    `/api/ships/${encodeURIComponent(pilotId)}/field-diagnostic?radius=52000&limit=16`,
  );
  return payload.diagnostic;
}

export async function upgradeShip(
  pilotId: string,
  request: UpgradeRequest,
): Promise<UpgradeResult> {
  const payload = await requestJson<{ result: UpgradeResult }>(
    `/api/ships/${encodeURIComponent(pilotId)}/upgrade`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  return payload.result;
}

export async function postChat(request: ChatRequest): Promise<ChatMessage> {
  const payload = await requestJson<{ message: ChatMessage }>("/api/chat", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return payload.message;
}

export function openWorldStream(
  pilotId: string,
  onMessage: (message: WorldStreamServerMessage) => void,
  onError: (error: Error) => void,
): WebSocket {
  const url = new URL(`${streamBase()}/api/world/stream`);
  url.searchParams.set("pilotId", pilotId);
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    try {
      onMessage(JSON.parse(String(event.data)) as WorldStreamServerMessage);
    } catch (error) {
      onError(error instanceof Error ? error : new Error("Malformed stream message."));
    }
  });
  socket.addEventListener("error", () => {
    onError(new Error("World stream connection failed."));
  });
  return socket;
}

export function sendWorldStreamMessage(
  socket: WebSocket | null,
  message: WorldStreamClientMessage,
): boolean {
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(payload.error ?? response.statusText);
  }
  return (await response.json()) as T;
}

function streamBase(): string {
  if (apiBase.length > 0) {
    return apiBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}
