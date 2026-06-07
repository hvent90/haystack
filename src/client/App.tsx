import { Canvas, useFrame } from "@react-three/fiber";
import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Crosshair,
  Gauge,
  House,
  Map as MapIcon,
  MessageSquare,
  Minus,
  Pickaxe,
  Radio,
  ScanLine,
  Send,
  Ship as ShipIcon,
  UserRound,
  UsersRound,
  Wrench,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Object3D, type InstancedMesh, type Mesh } from "three";

import {
  buildBase,
  createPilot,
  fieldDiagnostic,
  getPilot,
  getWorld,
  mine,
  openWorldStream,
  postChat,
  pulseScan,
  sellCargo,
  sendWorldStreamMessage,
  sendThrust,
  type Session,
  upgradeShip,
} from "./api";
import type {
  Asteroid,
  Deposit,
  ScanMode,
  ScanReport,
  Ship,
  Structure,
  ThrustCommand,
  UpgradeSystem,
  Vector3,
  WorldSnapshot,
} from "../shared/types";

const localPilotKey = "haystack.pilotId";
const scannerModes: ScanMode[] = ["belt", "pocket", "surface"];
const chatChannels = ["global", "belt", "dm"] as const;
const heldInputIntervalMs = 120;
const upgradeSystems: UpgradeSystem[] = ["cargo", "scanner", "mining", "stabilizer"];
const upgradeLabels: Record<UpgradeSystem, string> = {
  cargo: "Cargo Rack",
  scanner: "Scanner",
  mining: "Mining Head",
  stabilizer: "Stabilizer",
};

export function App(): ReactNode {
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [scanMode, setScanMode] = useState<ScanMode>("pocket");
  const [selectedAsteroidId, setSelectedAsteroidId] = useState<string>("");
  const [latestScan, setLatestScan] = useState<ScanReport | null>(null);
  const [fieldStats, setFieldStats] = useState<string | null>(null);
  const [chatChannel, setChatChannel] = useState<(typeof chatChannels)[number]>("global");
  const [chatTargetPilotId, setChatTargetPilotId] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<WebSocket | null>(null);
  const clientTickRef = useRef(0);
  const heldKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void boot().catch((nextError: unknown) => {
      if (!cancelled) {
        setError(messageFrom(nextError));
      }
    });
    return () => {
      cancelled = true;
    };

    async function boot(): Promise<void> {
      const queryPilotId = new URLSearchParams(window.location.search).get("pilotId");
      const storedPilotId = queryPilotId ?? window.localStorage.getItem(localPilotKey);
      if (storedPilotId !== null) {
        const pilot = await getPilot(storedPilotId);
        if (pilot !== null) {
          const world = await getWorld(pilot.id);
          if (!cancelled) {
            window.localStorage.setItem(localPilotKey, pilot.id);
            setSession({ pilot, snapshot: world });
            setSnapshot(world);
          }
          return;
        }
      }

      const callsign = `Prospector-${Math.floor(1000 + Math.random() * 9000)}`;
      const nextSession = await createPilot({ callsign });
      if (!cancelled) {
        window.localStorage.setItem(localPilotKey, nextSession.pilot.id);
        setSession(nextSession);
        setSnapshot(nextSession.snapshot);
      }
    }
  }, []);

  useEffect(() => {
    if (session === null) {
      return undefined;
    }

    const stream = openWorldStream(
      session.pilot.id,
      (message) => {
        switch (message.type) {
          case "hello":
            setSnapshot(message.snapshot);
            return;
          case "delta":
            setSnapshot((current) =>
              current === null ? current : { ...current, ...message.patch },
            );
            return;
          case "ack":
            setSnapshot((current) => {
              if (current === null) {
                return current;
              }
              return {
                ...current,
                ships: current.ships.map((ship) =>
                  ship.pilotId === message.ship.pilotId ? message.ship : ship,
                ),
              };
            });
            return;
          case "error":
            setError(message.message);
            return;
        }
      },
      (nextError) => setError(nextError.message),
    );
    streamRef.current = stream;

    const refresh = (): void => {
      void getWorld(session.pilot.id)
        .then(setSnapshot)
        .catch((nextError: unknown) => setError(messageFrom(nextError)));
    };
    const interval = window.setInterval(refresh, 4000);
    return () => {
      window.clearInterval(interval);
      stream.close();
      if (streamRef.current === stream) {
        streamRef.current = null;
      }
    };
  }, [session]);

  useEffect(() => {
    if (session === null) {
      return undefined;
    }

    function keyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (!isFlightKey(event.code)) {
        return;
      }
      event.preventDefault();
      heldKeysRef.current.add(event.code);
    }

    function keyUp(event: KeyboardEvent): void {
      heldKeysRef.current.delete(event.code);
    }

    const interval = window.setInterval(() => {
      const command = commandFromKeys(heldKeysRef.current);
      if (command !== null) {
        sendFlightCommand(command.impulse, command.stabilize);
      }
    }, heldInputIntervalMs);

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      heldKeysRef.current.clear();
    };
  }, [session]);

  const myShip = useMemo(() => {
    if (snapshot === null || session === null) {
      return null;
    }
    return snapshot.ships.find((ship) => ship.pilotId === session.pilot.id) ?? null;
  }, [snapshot, session]);

  const visibleAsteroids = useMemo(() => {
    if (snapshot === null) {
      return [];
    }
    return snapshot.asteroids.filter((asteroid) => asteroid.discovered).slice(0, 18);
  }, [snapshot]);

  const visibleStructures = useMemo(() => {
    if (snapshot === null) {
      return [];
    }
    return snapshot.structures.filter((structure) => structure.discovered);
  }, [snapshot]);

  const selectedSurfaceDeposits = useMemo(() => {
    if (snapshot === null) {
      return [];
    }
    return snapshot.deposits.filter(
      (deposit) => deposit.discovered && deposit.asteroidId === selectedAsteroidId,
    );
  }, [selectedAsteroidId, snapshot]);

  const visibleChat = useMemo(() => {
    if (snapshot === null || session === null) {
      return [];
    }
    return snapshot.chat.filter((message) => {
      if (message.channel !== chatChannel) {
        return false;
      }
      if (chatChannel !== "dm" || chatTargetPilotId.length === 0) {
        return true;
      }
      return (
        (message.fromPilotId === chatTargetPilotId && message.toPilotId === session.pilot.id) ||
        (message.fromPilotId === session.pilot.id && message.toPilotId === chatTargetPilotId)
      );
    });
  }, [chatChannel, chatTargetPilotId, session, snapshot]);

  const canAct = session !== null && myShip !== null && !busy;
  const canFly = session !== null && myShip !== null;

  async function withAction(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action();
      if (session !== null) {
        setSnapshot(await getWorld(session.pilot.id));
      }
    } catch (nextError: unknown) {
      setError(messageFrom(nextError));
    } finally {
      setBusy(false);
    }
  }

  function thrust(impulse: Vector3, stabilize = false): void {
    sendFlightCommand(impulse, stabilize);
  }

  function sendFlightCommand(impulse: Vector3, stabilize = false): void {
    if (session === null) {
      return;
    }
    const command = stabilize ? { impulse, stabilize } : { impulse };
    const sent = sendWorldStreamMessage(streamRef.current, {
      type: "input",
      pilotId: session.pilot.id,
      clientTick: (clientTickRef.current += 1),
      command,
    });
    if (sent) {
      setSnapshot((current) =>
        current === null ? current : predictFlightSnapshot(current, session.pilot.id, command),
      );
      return;
    }
    void withAction(async () => {
      await sendThrust(session.pilot.id, command);
    });
  }

  function scan(): void {
    if (session === null) {
      return;
    }
    void withAction(async () => {
      const request =
        selectedAsteroidId.length > 0
          ? { mode: scanMode, targetAsteroidId: selectedAsteroidId }
          : { mode: scanMode };
      const report = await pulseScan(session.pilot.id, request);
      setLatestScan(report);
      const firstAsteroid = report.hits.find((hit) => hit.kind === "asteroid");
      if (firstAsteroid !== undefined) {
        setSelectedAsteroidId(firstAsteroid.id);
      }
    });
  }

  function mineSelected(deposit: Deposit): void {
    if (session === null) {
      return;
    }
    void withAction(async () => {
      await mine(session.pilot.id, {
        asteroidId: deposit.asteroidId,
        depositId: deposit.id,
      });
    });
  }

  function sellAllCargo(): void {
    if (session === null) {
      return;
    }
    void withAction(async () => {
      await sellCargo(session.pilot.id, {});
    });
  }

  function deployHab(): void {
    if (session === null) {
      return;
    }
    void withAction(async () => {
      await buildBase(session.pilot.id, {
        name: `${session.pilot.callsign} Cache HAB`,
        hidden: true,
      });
    });
  }

  function upgrade(system: UpgradeSystem): void {
    if (session === null) {
      return;
    }
    void withAction(async () => {
      await upgradeShip(session.pilot.id, { system });
    });
  }

  function inspectField(): void {
    if (session === null) {
      return;
    }
    void withAction(async () => {
      const diagnostic = await fieldDiagnostic(session.pilot.id);
      setFieldStats(
        `${diagnostic.totalAsteroids.toLocaleString()} rocks, ${diagnostic.cellsVisited} cells, ${diagnostic.materializedAsteroids} candidates`,
      );
    });
  }

  function sendChat(): void {
    if (
      session === null ||
      chatDraft.trim().length === 0 ||
      (chatChannel === "dm" && chatTargetPilotId.length === 0)
    ) {
      return;
    }
    const body = chatDraft;
    setChatDraft("");
    void withAction(async () => {
      await postChat({
        channel: chatChannel,
        fromPilotId: session.pilot.id,
        body,
        ...(chatChannel === "dm" ? { toPilotId: chatTargetPilotId } : {}),
      });
    });
  }

  if (session === null || snapshot === null || myShip === null) {
    return (
      <main className="boot">
        <div className="boot-mark">H</div>
        <div>Acquiring station uplink</div>
      </main>
    );
  }

  return (
    <main className="app-shell" data-testid="haystack-app">
      <WorldView
        asteroids={visibleAsteroids}
        structures={visibleStructures}
        myShip={myShip}
        ships={snapshot.ships}
      />

      <div className="top-rail">
        <div className="brand">Haystack</div>
        <div className="rail-metric">
          <Gauge size={16} />
          <span>{myShip.heat.toFixed(1)} heat</span>
        </div>
        <div className="rail-metric">
          <Box size={16} />
          <span>
            {myShip.cargoMass.toFixed(1)} / {myShip.cargoCapacity}t
          </span>
        </div>
        <div className="rail-metric">
          <CircleDollarSign size={16} />
          <span>{snapshot.me?.credits.toFixed(0) ?? "0"} cr</span>
        </div>
        <div className="rail-metric">
          <House size={16} />
          <span>{snapshot.field.totalAsteroids.toLocaleString()} indexed</span>
        </div>
        <div className="rail-metric">
          <ShipIcon size={16} />
          <span>{meters(myShip.position)}</span>
        </div>
        {error !== null ? <div className="error-pill">{error}</div> : null}
      </div>

      <WindowFrame
        title="Flight"
        icon={<ShipIcon size={15} />}
        initial={{ x: 18, y: 86, width: 292, height: 292 }}
      >
        <div className="flight-pad">
          <button
            type="button"
            disabled={!canFly}
            onClick={() => thrust({ x: 0, y: 0, z: -8 })}
            title="Forward"
          >
            <ChevronUp size={20} />
          </button>
          <button
            type="button"
            disabled={!canFly}
            onClick={() => thrust({ x: -8, y: 0, z: 0 })}
            title="Left"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            disabled={!canFly}
            onClick={() => thrust({ x: 0, y: 0, z: 8 })}
            title="Reverse"
          >
            <ChevronDown size={20} />
          </button>
          <button
            type="button"
            disabled={!canFly}
            onClick={() => thrust({ x: 8, y: 0, z: 0 })}
            title="Right"
          >
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="axis-row">
          <button
            type="button"
            disabled={!canFly}
            onClick={() => thrust({ x: 0, y: 5, z: 0 })}
            title="Rise"
          >
            +Y
          </button>
          <button
            type="button"
            disabled={!canFly}
            onClick={() => thrust({ x: 0, y: -5, z: 0 })}
            title="Drop"
          >
            -Y
          </button>
          <button
            type="button"
            disabled={!canFly}
            className="danger"
            onClick={() => thrust({ x: 0, y: 0, z: 0 }, true)}
            title="Stabilize"
          >
            <Crosshair size={16} />
            Stabilize
          </button>
        </div>
        <StatGrid
          rows={[
            ["Velocity", `${vectorMagnitude(myShip.velocity).toFixed(1)} m/s`],
            ["Vector", meters(myShip.velocity)],
            ["Scanner", `${myShip.scanPower.toFixed(1)}x`],
            ["Mining", `${myShip.miningPower.toFixed(1)}t`],
          ]}
        />
      </WindowFrame>

      <WindowFrame
        title="Upgrades"
        icon={<Wrench size={15} />}
        initial={{ x: 1098, y: 86, width: 308, height: 326 }}
      >
        <StatGrid
          rows={[
            ["Cargo", `${myShip.cargoCapacity}t`],
            ["Scanner", `${myShip.scanPower.toFixed(2)}x`],
            ["Mining", `${myShip.miningPower.toFixed(1)}t`],
            ["Stabilizer", `${Math.round(myShip.stabilizerEfficiency * 100)}%`],
          ]}
        />
        <div className="upgrade-list">
          {upgradeSystems.map((system) => {
            const cost = upgradeCostEstimate(myShip, system);
            return (
              <button
                type="button"
                key={system}
                className="upgrade-command"
                disabled={!canAct || (snapshot.me?.credits ?? 0) < cost}
                onClick={() => upgrade(system)}
              >
                <span>
                  <strong>{upgradeLabels[system]}</strong>
                  <small>{upgradeEffect(system)}</small>
                </span>
                <b>{cost} cr</b>
              </button>
            );
          })}
        </div>
      </WindowFrame>

      <WindowFrame
        title="Scanner"
        icon={<ScanLine size={15} />}
        initial={{ x: 332, y: 86, width: 392, height: 410 }}
      >
        <div className="mode-switch">
          {scannerModes.map((mode) => (
            <button
              type="button"
              key={mode}
              className={scanMode === mode ? "active" : ""}
              disabled={!canAct}
              onClick={() => setScanMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Asteroid</span>
          <select
            value={selectedAsteroidId}
            onChange={(event) => setSelectedAsteroidId(event.currentTarget.value)}
          >
            <option value="">nearest return</option>
            {visibleAsteroids.map((asteroid) => (
              <option key={asteroid.id} value={asteroid.id}>
                {asteroid.id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!canAct} className="primary-command" onClick={scan}>
          <Radio size={16} />
          Pulse
        </button>
        <div className="scan-list">
          {(latestScan?.hits ?? []).map((hit) => (
            <button
              type="button"
              key={hit.id}
              className="scan-hit"
              onClick={() => hit.kind === "asteroid" && setSelectedAsteroidId(hit.id)}
            >
              <span>
                <strong>{hit.label}</strong>
                <small>{hit.clue}</small>
              </span>
              <b>{Math.round(hit.strength * 100)}%</b>
            </button>
          ))}
        </div>
      </WindowFrame>

      <WindowFrame
        title="Cargo"
        icon={<Pickaxe size={15} />}
        initial={{ x: 746, y: 86, width: 340, height: 326 }}
      >
        <div className="cargo-meter">
          <div
            style={{ width: `${Math.min(100, (myShip.cargoMass / myShip.cargoCapacity) * 100)}%` }}
          />
        </div>
        <div className="cargo-list">
          {snapshot.cargo.length === 0 ? <span className="empty">hold empty</span> : null}
          {snapshot.cargo.map((item) => (
            <div key={item.mineral} className="cargo-item">
              <span>{item.mineral}</span>
              <b>{item.mass.toFixed(1)}t</b>
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={!canAct || snapshot.cargo.length === 0}
          className="primary-command"
          onClick={sellAllCargo}
        >
          <CircleDollarSign size={16} />
          Sell
        </button>
        <div className="deposit-list">
          {selectedSurfaceDeposits.map((deposit) => (
            <button
              type="button"
              key={deposit.id}
              disabled={!canAct}
              onClick={() => mineSelected(deposit)}
            >
              <Pickaxe size={16} />
              <span>{deposit.mineral}</span>
              <b>{deposit.remaining.toFixed(1)}t</b>
            </button>
          ))}
        </div>
      </WindowFrame>

      <WindowFrame
        title="Comms"
        icon={<MessageSquare size={15} />}
        initial={{ x: 18, y: 410, width: 420, height: 326 }}
      >
        <div className="chat-controls">
          <select
            value={chatChannel}
            onChange={(event) =>
              setChatChannel(event.currentTarget.value as (typeof chatChannels)[number])
            }
          >
            {chatChannels.map((channel) => (
              <option key={channel} value={channel}>
                {channel}
              </option>
            ))}
          </select>
          {chatChannel === "dm" ? (
            <select
              value={chatTargetPilotId}
              onChange={(event) => setChatTargetPilotId(event.currentTarget.value)}
            >
              <option value="">select pilot</option>
              {snapshot.pilots
                .filter((pilot) => pilot.id !== session.pilot.id)
                .map((pilot) => (
                  <option key={pilot.id} value={pilot.id}>
                    {pilot.callsign}
                  </option>
                ))}
            </select>
          ) : null}
        </div>
        <div className="chat-log">
          {visibleChat.map((message) => (
            <div key={message.id} className="chat-line">
              <b>
                {message.channel === "dm" ? `${message.fromCallsign} dm` : message.fromCallsign}
              </b>
              <span>{message.body}</span>
            </div>
          ))}
        </div>
        <div className="chat-input">
          <input
            value={chatDraft}
            onChange={(event) => setChatDraft(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && sendChat()}
          />
          <button
            type="button"
            disabled={
              !canAct ||
              chatDraft.trim().length === 0 ||
              (chatChannel === "dm" && chatTargetPilotId.length === 0)
            }
            onClick={sendChat}
            title="Send"
          >
            <Send size={16} />
          </button>
        </div>
      </WindowFrame>

      <WindowFrame
        title="Cards"
        icon={<UserRound size={15} />}
        initial={{ x: 460, y: 520, width: 370, height: 268 }}
      >
        <div className="cards-list">
          {snapshot.pilots.map((pilot) => {
            const cardShip = snapshot.ships.find((ship) => ship.pilotId === pilot.id);
            const shipTelemetry =
              cardShip === undefined
                ? pilot.shipName
                : `${Math.round(rangeBetween(myShip.position, cardShip.position))}m ${vectorMagnitude(cardShip.velocity).toFixed(1)}m/s`;
            return (
              <div
                key={pilot.id}
                className={pilot.id === session.pilot.id ? "pilot-card me" : "pilot-card"}
              >
                <div>
                  <strong>{pilot.callsign}</strong>
                  <small>{pilot.organization}</small>
                </div>
                <span>{shipTelemetry}</span>
              </div>
            );
          })}
        </div>
      </WindowFrame>

      <WindowFrame
        title="Map"
        icon={<MapIcon size={15} />}
        initial={{ x: 1210, y: 430, width: 340, height: 310 }}
      >
        <MapPanel snapshot={snapshot} myShip={myShip} />
      </WindowFrame>

      <WindowFrame
        title="Org"
        icon={<UsersRound size={15} />}
        initial={{ x: 460, y: 806, width: 370, height: 238 }}
      >
        <OrgPanel snapshot={snapshot} />
      </WindowFrame>

      <WindowFrame
        title="Bases"
        icon={<House size={15} />}
        initial={{ x: 852, y: 430, width: 344, height: 310 }}
      >
        <button type="button" disabled={!canAct} className="primary-command" onClick={deployHab}>
          <House size={16} />
          Deploy HAB
        </button>
        <button
          type="button"
          disabled={!canAct}
          className="secondary-command"
          onClick={inspectField}
        >
          <Radio size={16} />
          Field Index
        </button>
        {fieldStats !== null ? <div className="field-stats">{fieldStats}</div> : null}
        <div className="structure-list">
          {snapshot.structures
            .filter((structure) => structure.discovered)
            .map((structure) => (
              <div
                key={structure.id}
                className={
                  structure.ownerPilotId === session.pilot.id
                    ? "structure-item owned"
                    : "structure-item"
                }
              >
                <span>
                  <strong>{structure.name}</strong>
                  <small>
                    {structure.kind}
                    {structure.hidden ? " hidden" : ""}
                  </small>
                </span>
                <b>{structure.signature.toFixed(2)}</b>
              </div>
            ))}
        </div>
      </WindowFrame>
    </main>
  );
}

type WindowFrameProps = {
  title: string;
  icon: ReactNode;
  initial: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  children: ReactNode;
};

function WindowFrame({ title, icon, initial, children }: WindowFrameProps): ReactNode {
  const [position, setPosition] = useState({ x: initial.x, y: initial.y });
  const [drag, setDrag] = useState<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [dock, setDock] = useState<"floating" | "left" | "right">("floating");

  useEffect(() => {
    if (drag === null) {
      return undefined;
    }
    const { originX, originY, startX, startY } = drag;

    function move(event: globalThis.PointerEvent): void {
      setPosition({
        x: Math.max(10, originX + event.clientX - startX),
        y: Math.max(56, originY + event.clientY - startY),
      });
    }

    function stop(): void {
      setDrag(null);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [drag]);

  function beginDrag(event: PointerEvent<HTMLDivElement>): void {
    if (dock !== "floating") {
      return;
    }
    setDrag({
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    });
  }

  const style =
    dock === "floating"
      ? ({
          left: position.x,
          top: position.y,
          width: initial.width,
          height: minimized ? 42 : initial.height,
        } satisfies CSSProperties)
      : ({
          width: initial.width,
          height: minimized ? 42 : initial.height,
        } satisfies CSSProperties);

  const className = `window-frame ${dock !== "floating" ? `dock-${dock}` : ""}`;

  return (
    <section className={className} style={style}>
      <div className="window-titlebar" onPointerDown={beginDrag}>
        <span>
          {icon}
          {title}
        </span>
        <div>
          <button
            type="button"
            onClick={() =>
              setDock(dock === "floating" ? "right" : dock === "right" ? "left" : "floating")
            }
            title="Dock"
          >
            <Crosshair size={14} />
          </button>
          <button type="button" onClick={() => setMinimized(!minimized)} title="Minimize">
            <Minus size={14} />
          </button>
        </div>
      </div>
      {!minimized ? <div className="window-body">{children}</div> : null}
    </section>
  );
}

function WorldView({
  asteroids,
  structures,
  ships,
  myShip,
}: {
  asteroids: Asteroid[];
  structures: Structure[];
  ships: Ship[];
  myShip: Ship;
}): ReactNode {
  return (
    <div className="world-stage">
      <Canvas camera={{ position: [0, 9, 18], fov: 52 }} dpr={[1, 1.5]}>
        <color attach="background" args={["#10100f"]} />
        <ambientLight intensity={0.62} />
        <pointLight position={[8, 12, 10]} intensity={1.4} color="#f5c16f" />
        <group rotation={[0.18, -0.24, 0]}>
          <GridStars />
          <ShipMesh />
          <InstancedAsteroids asteroids={asteroids} origin={myShip.position} />
          {structures.map((structure) => (
            <StructureMesh key={structure.id} structure={structure} origin={myShip.position} />
          ))}
          {ships
            .filter((ship) => ship.pilotId !== myShip.pilotId)
            .map((ship) => (
              <OtherShipMesh key={ship.pilotId} ship={ship} origin={myShip.position} />
            ))}
        </group>
      </Canvas>
      <div className="reticle" />
    </div>
  );
}

function ShipMesh(): ReactNode {
  const [mesh, setMesh] = useState<Mesh | null>(null);
  useFrame((_, delta) => {
    if (mesh !== null) {
      mesh.rotation.z += delta * 0.55;
    }
  });

  return (
    <group>
      <mesh ref={setMesh} position={[0, 0, 0]}>
        <coneGeometry args={[0.45, 1.6, 4]} />
        <meshStandardMaterial color="#e0dfcf" roughness={0.72} metalness={0.18} />
      </mesh>
      <mesh position={[0, -0.46, 0.18]} scale={[0.72, 0.18, 0.45]}>
        <boxGeometry />
        <meshStandardMaterial color="#7fb39c" roughness={0.88} />
      </mesh>
      <mesh position={[0, 0.72, 0.05]} scale={[0.3, 0.3, 0.3]}>
        <boxGeometry />
        <meshStandardMaterial color="#c87b3c" emissive="#492311" emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

function InstancedAsteroids({
  asteroids,
  origin,
}: {
  asteroids: Asteroid[];
  origin: Vector3;
}): ReactNode {
  const meshRef = useRef<InstancedMesh>(null);
  const transform = useMemo(() => new Object3D(), []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }

    asteroids.forEach((asteroid, index) => {
      const position = toScene(asteroid.position, origin);
      const size = Math.max(0.2, asteroid.radius / 310);
      transform.position.set(position.x, position.y, position.z);
      transform.rotation.set(index * 0.43, index * 0.27, 0);
      transform.scale.set(size, size, size);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [asteroids, origin, transform]);

  if (asteroids.length === 0) {
    return null;
  }

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, asteroids.length]}>
      <dodecahedronGeometry args={[1, 0]} />
      <meshStandardMaterial color="#6f6a60" roughness={0.96} />
    </instancedMesh>
  );
}

function StructureMesh({
  structure,
  origin,
}: {
  structure: Structure;
  origin: Vector3;
}): ReactNode {
  const position = toScene(structure.position, origin);
  return (
    <group position={[position.x, position.y, position.z]}>
      <mesh scale={structure.kind === "station" ? [1.6, 0.5, 1.6] : [0.55, 0.85, 0.55]}>
        <boxGeometry />
        <meshStandardMaterial color={structure.hidden ? "#5b725e" : "#b58b55"} roughness={0.74} />
      </mesh>
      <mesh position={[0, 0.72, 0]} scale={[0.32, 0.32, 0.32]}>
        <octahedronGeometry />
        <meshStandardMaterial color="#87d0bd" emissive="#0f3f35" emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

function OtherShipMesh({ ship, origin }: { ship: Ship; origin: Vector3 }): ReactNode {
  const position = toScene(ship.position, origin);
  return (
    <mesh position={[position.x, position.y, position.z]} scale={[0.42, 0.42, 0.42]}>
      <coneGeometry args={[0.6, 1.4, 4]} />
      <meshStandardMaterial color="#b54f57" roughness={0.7} />
    </mesh>
  );
}

function GridStars(): ReactNode {
  const points = useMemo(() => {
    return Array.from({ length: 90 }, (_, index) => {
      const angle = index * 2.39996;
      const radius = 18 + (index % 17) * 1.8;
      return {
        x: Math.cos(angle) * radius,
        y: ((index % 23) - 11) * 0.6,
        z: Math.sin(angle) * radius,
      };
    });
  }, []);

  return (
    <group>
      {points.map((point, index) => (
        <mesh
          key={index}
          position={[point.x, point.y, point.z]}
          scale={0.025 + (index % 4) * 0.012}
        >
          <boxGeometry />
          <meshBasicMaterial color={index % 5 === 0 ? "#d6b36f" : "#c8d2c5"} />
        </mesh>
      ))}
    </group>
  );
}

function MapPanel({ snapshot, myShip }: { snapshot: WorldSnapshot; myShip: Ship }): ReactNode {
  const map = useMemo(() => buildMap(snapshot, myShip), [myShip, snapshot]);
  return (
    <>
      <div className="map-grid">
        {map.pockets.map((pocket) => (
          <div
            key={pocket.name}
            className="map-pocket"
            style={{
              left: `${pocket.x}%`,
              top: `${pocket.y}%`,
              width: `${pocket.size}%`,
              height: `${pocket.size}%`,
            }}
          >
            <span>{pocket.name}</span>
          </div>
        ))}
        {map.markers.map((marker) => (
          <div
            key={marker.id}
            className={`map-marker ${marker.kind}`}
            style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
            title={marker.label}
          />
        ))}
      </div>
      <div className="map-legend">
        {map.legend.map(([label, value]) => (
          <span key={label}>
            <b>{label}</b>
            {value}
          </span>
        ))}
      </div>
    </>
  );
}

function OrgPanel({ snapshot }: { snapshot: WorldSnapshot }): ReactNode {
  const organizationName = snapshot.me?.organization ?? "";
  const roster = snapshot.pilots.filter((pilot) => pilot.organization === organizationName);
  return (
    <>
      <div className="org-summary">
        {snapshot.organizations.map((organization) => (
          <div
            key={organization.name}
            className={organization.name === organizationName ? "org-item active" : "org-item"}
          >
            <span>
              <strong>{organization.name}</strong>
              <small>
                {organization.memberCount} pilots, {organization.activeShipCount} ships
              </small>
            </span>
            <b>{organization.totalCredits.toFixed(0)} cr</b>
          </div>
        ))}
      </div>
      <div className="org-roster">
        {roster.map((pilot) => (
          <div key={pilot.id} className="org-roster-item">
            <span>
              <strong>{pilot.callsign}</strong>
              <small>{pilot.shipName}</small>
            </span>
            <b>{pilot.cargoMass.toFixed(1)}t</b>
          </div>
        ))}
      </div>
    </>
  );
}

function StatGrid({ rows }: { rows: Array<[string, string]> }): ReactNode {
  return (
    <dl className="stat-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function isFlightKey(code: string): boolean {
  return (
    code === "KeyW" ||
    code === "KeyA" ||
    code === "KeyS" ||
    code === "KeyD" ||
    code === "ArrowUp" ||
    code === "ArrowDown" ||
    code === "ArrowLeft" ||
    code === "ArrowRight" ||
    code === "Space" ||
    code === "ControlLeft" ||
    code === "ControlRight" ||
    code === "KeyX" ||
    code === "KeyZ"
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function commandFromKeys(keys: Set<string>): ThrustCommand | null {
  const xAxis =
    Number(keys.has("KeyD") || keys.has("ArrowRight")) -
    Number(keys.has("KeyA") || keys.has("ArrowLeft"));
  const yAxis =
    Number(keys.has("Space")) - Number(keys.has("ControlLeft") || keys.has("ControlRight"));
  const zAxis =
    Number(keys.has("KeyS") || keys.has("ArrowDown")) -
    Number(keys.has("KeyW") || keys.has("ArrowUp"));
  const stabilize = keys.has("KeyX") || keys.has("KeyZ");
  const impulse = {
    x: xAxis * 2.2,
    y: yAxis * 1.6,
    z: zAxis * 2.2,
  };
  if (!stabilize && vectorMagnitude(impulse) <= 0) {
    return null;
  }
  return stabilize ? { impulse, stabilize } : { impulse };
}

function predictFlightSnapshot(
  snapshot: WorldSnapshot,
  pilotId: string,
  command: ThrustCommand,
): WorldSnapshot {
  return {
    ...snapshot,
    ships: snapshot.ships.map((ship) =>
      ship.pilotId === pilotId ? predictShipAfterCommand(ship, command) : ship,
    ),
  };
}

function predictShipAfterCommand(ship: Ship, command: ThrustCommand): Ship {
  const impulse = clampVector(command.impulse, 12);
  const stabilization = command.stabilize === true && ship.heat < 96;
  const dampening = stabilization ? 1 - ship.stabilizerEfficiency : 1;
  const heatAdded = vectorMagnitude(impulse) * 1.8 + (stabilization ? 18 : 0);
  return {
    ...ship,
    velocity: {
      x: round((ship.velocity.x + impulse.x) * dampening),
      y: round((ship.velocity.y + impulse.y) * dampening),
      z: round((ship.velocity.z + impulse.z) * dampening),
    },
    heat: round(Math.min(100, ship.heat + heatAdded)),
  };
}

type MapMarker = {
  id: string;
  kind: "me" | "ship" | "station" | "base" | "asteroid";
  label: string;
  x: number;
  y: number;
};

type MapPocket = {
  name: string;
  x: number;
  y: number;
  size: number;
};

function buildMap(
  snapshot: WorldSnapshot,
  myShip: Ship,
): {
  markers: MapMarker[];
  pockets: MapPocket[];
  legend: Array<[string, string]>;
} {
  const visibleAsteroids = snapshot.asteroids.filter((asteroid) => asteroid.discovered);
  const visibleStructures = snapshot.structures.filter((structure) => structure.discovered);
  const positions = [
    myShip.position,
    ...snapshot.ships.map((ship) => ship.position),
    ...visibleAsteroids.map((asteroid) => asteroid.position),
    ...visibleStructures.map((structure) => structure.position),
  ];
  const bounds = mapBounds(positions);

  const markers: MapMarker[] = [
    {
      id: "me",
      kind: "me",
      label: myShip.name,
      ...projectMap(myShip.position, bounds),
    },
    ...snapshot.ships
      .filter((ship) => ship.pilotId !== myShip.pilotId)
      .map((ship) => ({
        id: `ship-${ship.pilotId}`,
        kind: "ship" as const,
        label: ship.name,
        ...projectMap(ship.position, bounds),
      })),
    ...visibleStructures.map((structure) => ({
      id: structure.id,
      kind: structure.kind === "station" ? ("station" as const) : ("base" as const),
      label: structure.name,
      ...projectMap(structure.position, bounds),
    })),
    ...visibleAsteroids.slice(0, 28).map((asteroid) => ({
      id: asteroid.id,
      kind: "asteroid" as const,
      label: asteroid.id,
      ...projectMap(asteroid.position, bounds),
    })),
  ];

  const pocketNames = [...new Set(snapshot.asteroids.map((asteroid) => asteroid.pocket))];
  const pockets = pocketNames.flatMap((name) => {
    const asteroids = snapshot.asteroids.filter((asteroid) => asteroid.pocket === name);
    if (asteroids.length === 0) {
      return [];
    }
    const center = averagePosition(asteroids.map((asteroid) => asteroid.position));
    return [
      {
        name,
        ...projectMap(center, bounds),
        size: Math.max(18, Math.min(42, 18 + asteroids.length)),
      },
    ];
  });

  return {
    markers,
    pockets,
    legend: [
      ["Grid", `${snapshot.field.totalAsteroids.toLocaleString()} rocks`],
      ["Visible", `${visibleAsteroids.length} asteroids`],
      ["Ships", `${snapshot.ships.length}`],
    ],
  };
}

function mapBounds(positions: Vector3[]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  const xs = positions.map((position) => position.x);
  const zs = positions.map((position) => position.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const padX = Math.max(12000, (maxX - minX) * 0.18);
  const padZ = Math.max(12000, (maxZ - minZ) * 0.18);
  return {
    minX: minX - padX,
    maxX: maxX + padX,
    minZ: minZ - padZ,
    maxZ: maxZ + padZ,
  };
}

function projectMap(
  position: Vector3,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): { x: number; y: number } {
  return {
    x: clampPercent(((position.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX)) * 100),
    y: clampPercent(((position.z - bounds.minZ) / Math.max(1, bounds.maxZ - bounds.minZ)) * 100),
  };
}

function averagePosition(positions: Vector3[]): Vector3 {
  const total = positions.reduce(
    (sum, position) => ({
      x: sum.x + position.x,
      y: sum.y + position.y,
      z: sum.z + position.z,
    }),
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: total.x / positions.length,
    y: total.y / positions.length,
    z: total.z / positions.length,
  };
}

function clampPercent(value: number): number {
  return Math.max(4, Math.min(96, value));
}

function toScene(position: Vector3, origin: Vector3): Vector3 {
  return {
    x: (position.x - origin.x) / 9000,
    y: (position.y - origin.y) / 9000,
    z: (position.z - origin.z) / 9000,
  };
}

function vectorMagnitude(vector: Vector3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function clampVector(vector: Vector3, maxLength: number): Vector3 {
  const magnitude = vectorMagnitude(vector);
  if (magnitude <= maxLength) {
    return vector;
  }
  const scale = maxLength / magnitude;
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function rangeBetween(left: Vector3, right: Vector3): number {
  return vectorMagnitude({
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  });
}

function meters(vector: Vector3): string {
  return `${vector.x.toFixed(0)}, ${vector.y.toFixed(0)}, ${vector.z.toFixed(0)}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function upgradeCostEstimate(ship: Ship, system: UpgradeSystem): number {
  switch (system) {
    case "cargo":
      return Math.round(300 + Math.max(0, ship.cargoCapacity - 180) * 2.2);
    case "scanner":
      return Math.round(420 * ship.scanPower);
    case "mining":
      return Math.round(360 + Math.max(0, ship.miningPower - 22) * 24);
    case "stabilizer":
      return Math.round(280 + ship.stabilizerEfficiency * 600);
  }
}

function upgradeEffect(system: UpgradeSystem): string {
  switch (system) {
    case "cargo":
      return "+60t hold";
    case "scanner":
      return "+0.28 scan";
    case "mining":
      return "+6t yield";
    case "stabilizer":
      return "+8% damping";
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
