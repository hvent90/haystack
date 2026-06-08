import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CharacterCard,
  Deposit,
  FieldDiagnostic,
  FlightInputCommand,
  ScanMode,
  ScanReport,
  Ship,
  ThrustCommand,
  UpgradeSystem,
  Vector3,
  WorldSnapshot,
} from "../../shared/types";
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
  resetShip,
  sellCargo,
  sendThrust,
  sendWorldStreamMessage,
  type Session,
  upgradeShip,
} from "../api";
import { ContextMenu } from "./components/ContextMenu";
import { HudCluster } from "./components/HudCluster";
import { Neocom } from "./components/Neocom";
import { SelectedItemPanel } from "./components/SelectedItemPanel";
import { ShowInfoCard } from "./components/ShowInfoCard";
import { TopRail } from "./components/TopRail";
import { WindowFrame } from "./components/WindowFrame";
import { WorldView } from "./components/WorldView";
import { BasesWindow } from "./components/windows/BasesWindow";
import { CargoWindow } from "./components/windows/CargoWindow";
import { CharacterWindow } from "./components/windows/CharacterWindow";
import { CommsWindow } from "./components/windows/CommsWindow";
import { FlightWindow } from "./components/windows/FlightWindow";
import { ScannerWindow } from "./components/windows/ScannerWindow";
import {
  flightInputScaleMax,
  flightInputScaleMin,
  flightInputScaleWheelDivisor,
  flightInputIntervalMs,
  localPilotKey,
  mouseSensitivity,
  relativeMouseDecay,
  throttleStep,
  windowDefinitions,
} from "./constants";
import { isEditableTarget, isFlightKey } from "./flight";
import {
  clampLayout,
  createDefaultLayout,
  layoutKey,
  loadLayout,
  patchWindowState,
} from "./layout";
import { buildOverviewRows, filterOverviewRows, sameSelection, sortOverviewRows } from "./overview";
import {
  mergeWorldPatchForOwnedPrediction,
  mergeWorldSnapshotForOwnedPrediction,
  OwnedShipPrediction,
  replaceOwnedShip,
} from "./prediction";
import { FieldDeriver, withDerivedField } from "./field-derivation";
import { flightRenderStore } from "./renderStore";
import type {
  ChatChannel,
  ContextMenuState,
  FlightMode,
  LayoutState,
  OneShotFlightInput,
  OverviewFilter,
  OverviewRow,
  Selection,
  SortField,
  SortState,
  Waypoint,
  WindowKey,
  WindowState,
} from "./types";
import { clamp } from "./vector";
import { AudioControls } from "../audio/AudioControls";
import { spatialMasterVolume } from "../audio/spatial";
import { useAudio } from "../audio/useAudio";

export function EveApp(): ReactNode {
  const [session, setSession] = useState<Session | null>(null);
  const audio = useAudio();
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [layout, setLayout] = useState<LayoutState>(() => createDefaultLayout());
  const [layoutLoadedFor, setLayoutLoadedFor] = useState<string | null>(null);
  const [focusedWindow, setFocusedWindow] = useState<WindowKey>("scanner");
  const [scanMode, setScanMode] = useState<ScanMode>("pocket");
  const [overviewFilter, setOverviewFilter] = useState<OverviewFilter>("all");
  const [sort, setSort] = useState<SortState>({ field: "distance", direction: "asc" });
  const [latestScan, setLatestScan] = useState<ScanReport | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [waypoint, setWaypoint] = useState<Waypoint | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showInfoTarget, setShowInfoTarget] = useState<Selection | null>(null);
  const [chatChannel, setChatChannel] = useState<ChatChannel>("global");
  const [chatTargetPilotId, setChatTargetPilotId] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [fieldStats, setFieldStats] = useState<FieldDiagnostic | null>(null);
  const [busyActions, setBusyActions] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [unreadComms, setUnreadComms] = useState(0);
  const [flightMode, setFlightMode] = useState<FlightMode>("cursor");
  const [throttle, setThrottle] = useState(0);
  const [keyboardThrottle, setKeyboardThrottle] = useState(0);
  const [cruiseLock, setCruiseLock] = useState(false);
  const [mouseDeflection, setMouseDeflection] = useState<Vector3>({ x: 0, y: 0, z: 0 });
  const [flightInputScale, setFlightInputScale] = useState(flightInputScaleMax);
  const [flashlightOn, setFlashlightOn] = useState(false);
  const [scanNonce, setScanNonce] = useState(0);
  const streamRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const predictionRef = useRef(new OwnedShipPrediction());
  const fieldDeriverRef = useRef(new FieldDeriver());
  const heldKeysRef = useRef<Set<string>>(new Set());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const flightModeRef = useRef<FlightMode>("cursor");
  const mouseDeflectionRef = useRef<Vector3>({ x: 0, y: 0, z: 0 });
  const flightInputScaleRef = useRef(flightInputScaleMax);
  const flightStateRef = useRef({ throttle: 0, cruiseLock: false });
  const oneShotRef = useRef<OneShotFlightInput>({ boost: false });
  const lastFlightActiveRef = useRef(false);
  const syncedFlightPilotRef = useRef<string | null>(null);
  const myShipRef = useRef<Ship | null>(null);
  const previousChatIdsRef = useRef<Set<string>>(new Set());
  const predictCommitRef = useRef(0);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

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
            resetPredictionFromSnapshot(world, pilot.id);
            setSession({ pilot, snapshot: world });
            fieldDeriverRef.current.setSeeded(world.asteroids);
            setSnapshot(withDerivedField(world, fieldDeriverRef.current, pilot.id));
          }
          return;
        }
      }

      const callsign = `Prospector-${Math.floor(1000 + Math.random() * 9000)}`;
      const nextSession = await createPilot({ callsign });
      const world = await getWorld(nextSession.pilot.id);
      if (!cancelled) {
        window.localStorage.setItem(localPilotKey, nextSession.pilot.id);
        resetPredictionFromSnapshot(world, nextSession.pilot.id);
        setSession({ pilot: nextSession.pilot, snapshot: world });
        fieldDeriverRef.current.setSeeded(world.asteroids);
        setSnapshot(withDerivedField(world, fieldDeriverRef.current, nextSession.pilot.id));
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
            resetPredictionFromSnapshot(message.snapshot, session.pilot.id);
            pushRemotesToStore(message.snapshot.ships, session.pilot.id, message.serverTimeMs);
            fieldDeriverRef.current.setSeeded(message.snapshot.asteroids);
            setSnapshot(
              withDerivedField(message.snapshot, fieldDeriverRef.current, session.pilot.id),
            );
            return;
          case "delta":
            if (message.patch.ships !== undefined) {
              pushRemotesToStore(message.patch.ships, session.pilot.id, message.serverTimeMs);
            }
            setSnapshot((current) => {
              if (current === null) {
                return current;
              }
              const predictedShip = predictedShipForAuthoritativeMerge();
              if (predictedShip === null && message.patch.ships !== undefined) {
                const ownedShip =
                  message.patch.ships.find((ship) => ship.pilotId === session.pilot.id) ?? null;
                if (ownedShip !== null) {
                  predictionRef.current.reset(ownedShip);
                  flightRenderStore.resetOwned(ownedShip);
                }
              }
              const merged = mergeWorldPatchForOwnedPrediction(
                current,
                message.patch,
                session.pilot.id,
                predictedShip,
              );
              if (message.patch.asteroids !== undefined) {
                fieldDeriverRef.current.setSeeded(message.patch.asteroids);
              }
              return withDerivedField(merged, fieldDeriverRef.current, session.pilot.id);
            });
            return;
          case "ack": {
            // Reconcile against the authoritative ship and fold any correction
            // into the render store's decaying error (smooth) rather than
            // snapping. React state is refreshed by the throttled predicted
            // commit + deltas, so no per-ack setSnapshot is needed here.
            const outcome = predictionRef.current.reconcile(message.ackClientTick, message.ship);
            if (outcome.corrected) {
              flightRenderStore.correctOwned(outcome.ship);
            } else {
              flightRenderStore.setOwnedPredicted(outcome.ship);
            }
            return;
          }
          case "error":
            setError(message.message);
            return;
        }
      },
      (nextError) => setError(nextError.message),
    );
    streamRef.current = stream;

    const refresh = (): void => {
      void refreshSnapshot(session.pilot.id);
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
      return;
    }
    setLayout(loadLayout(session.pilot.id));
    setLayoutLoadedFor(session.pilot.id);
  }, [session?.pilot.id]);

  useEffect(() => {
    if (session === null || layoutLoadedFor !== session.pilot.id) {
      return;
    }
    window.localStorage.setItem(layoutKey(session.pilot.id), JSON.stringify(layout));
  }, [layout, layoutLoadedFor, session]);

  useEffect(() => {
    function reclamp(): void {
      setLayout((current) => clampLayout(current));
    }
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, []);

  useEffect(() => {
    flightStateRef.current = { throttle, cruiseLock };
  }, [cruiseLock, throttle]);

  useEffect(() => {
    function pointerLockChanged(): void {
      const locked = document.pointerLockElement === stageRef.current;
      flightModeRef.current = locked ? "flight" : "cursor";
      setFlightMode(locked ? "flight" : "cursor");
      if (!locked) {
        clearFlightInput();
        sendFlightInput(buildFlightInput(false));
      }
    }

    function mouseMove(event: MouseEvent): void {
      if (document.pointerLockElement !== stageRef.current && flightModeRef.current !== "flight") {
        return;
      }
      const next = {
        x: clamp(mouseDeflectionRef.current.x - event.movementY * mouseSensitivity, -1, 1),
        y: clamp(mouseDeflectionRef.current.y - event.movementX * mouseSensitivity, -1, 1),
        z: mouseDeflectionRef.current.z,
      };
      mouseDeflectionRef.current = next;
      setMouseDeflection(next);
    }

    function wheel(event: WheelEvent): void {
      if (flightModeRef.current !== "flight") {
        return;
      }
      event.preventDefault();
      setFlightInputScaleByWheel(event.deltaY);
    }

    function blur(): void {
      if (document.pointerLockElement !== null) {
        document.exitPointerLock();
      }
      clearFlightInput();
      sendFlightInput(buildFlightInput(false));
    }

    document.addEventListener("pointerlockchange", pointerLockChanged);
    document.addEventListener("mousemove", mouseMove);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerlockchange", pointerLockChanged);
      document.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    if (session === null) {
      return undefined;
    }

    function keyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        if (contextMenu !== null) {
          setContextMenu(null);
          event.preventDefault();
          return;
        }
        patchWindow(focusedWindow, { minimized: true });
        event.preventDefault();
        return;
      }

      if (event.code === "AltLeft") {
        event.preventDefault();
        toggleFlightLock();
        return;
      }

      // Flashlight toggle (F) and scan pulse (V) work in any mode, as long as the user is not
      // typing into a field. Placed before the flight-key gate so they fire in cursor mode too.
      if (!isEditableTarget(event.target) && !event.repeat) {
        if (event.code === "KeyF") {
          event.preventDefault();
          setFlashlightOn((on) => !on);
          return;
        }
        if (event.code === "KeyV") {
          event.preventDefault();
          setScanNonce((nonce) => nonce + 1);
          return;
        }
      }

      if (
        isEditableTarget(event.target) ||
        flightModeRef.current !== "flight" ||
        !isFlightKey(event.code)
      ) {
        return;
      }
      event.preventDefault();
      if (event.code === "Tab" && !event.repeat) {
        oneShotRef.current.boost = true;
        return;
      }
      if (event.code === "KeyJ" && !event.repeat) {
        toggleFlightCruiseLock();
        return;
      }
      heldKeysRef.current.add(event.code);
      syncKeyboardThrottle();
    }

    function keyUp(event: globalThis.KeyboardEvent): void {
      heldKeysRef.current.delete(event.code);
      syncKeyboardThrottle();
    }

    const interval = window.setInterval(() => {
      const active = flightModeRef.current === "flight";
      const hasOneShot = oneShotRef.current.boost;
      if (!active && !lastFlightActiveRef.current && !hasOneShot) {
        return;
      }
      const flightInput = buildFlightInput(active);
      sendFlightInput(flightInput);
      lastFlightActiveRef.current = active;
      const nextMouseDeflection = {
        x: mouseDeflectionRef.current.x * relativeMouseDecay,
        y: mouseDeflectionRef.current.y * relativeMouseDecay,
        z: 0,
      };
      mouseDeflectionRef.current = nextMouseDeflection;
      setMouseDeflection(nextMouseDeflection);
      const ship = sessionRef.current === null ? null : myShipRef.current;
      if (ship !== null) {
        const { strafe, rotation } = flightInput;
        audio.engine.setEngineState({
          throttle: ship.throttle,
          // Maneuvering-thruster activity drives the RCS air-nozzle layer.
          rcs: Math.min(1, Math.hypot(strafe.x, strafe.y, strafe.z)),
          rotation: Math.min(1, Math.hypot(rotation.x, rotation.y, rotation.z)),
          boost: false,
          heat: ship.heat,
          cruiseLock: ship.cruiseLock,
          speed: Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z),
        });
      }
    }, flightInputIntervalMs);

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      clearFlightInput();
      sendFlightInput(buildFlightInput(false));
    };
  }, [contextMenu, focusedWindow, session]);

  useEffect(() => {
    if (contextMenu === null) {
      return undefined;
    }
    const close = (): void => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [contextMenu]);

  const myShip = useMemo(() => {
    if (snapshot === null || session === null) {
      return null;
    }
    return snapshot.ships.find((ship) => ship.pilotId === session.pilot.id) ?? null;
  }, [snapshot, session]);

  useEffect(() => {
    myShipRef.current = myShip;
  }, [myShip]);

  useEffect(() => {
    if (myShip === null || syncedFlightPilotRef.current === myShip.pilotId) {
      return;
    }
    syncedFlightPilotRef.current = myShip.pilotId;
    predictionRef.current.reset(myShip);
    flightRenderStore.resetOwned(myShip);
    setThrottle(myShip.throttle);
    setCruiseLock(myShip.cruiseLock);
  }, [myShip]);

  const meCard = useMemo(() => {
    if (snapshot?.me !== null && snapshot?.me !== undefined) {
      return snapshot.me;
    }
    if (session === null || myShip === null) {
      return null;
    }
    return {
      ...session.pilot,
      shipName: myShip.name,
      cargoMass: myShip.cargoMass,
      cargoCapacity: myShip.cargoCapacity,
      credits: 0,
      scanPower: myShip.scanPower,
      miningPower: myShip.miningPower,
    } satisfies CharacterCard;
  }, [myShip, session, snapshot]);

  const overviewRows = useMemo(() => {
    if (snapshot === null || myShip === null || session === null) {
      return [];
    }
    return buildOverviewRows(snapshot, myShip, session.pilot.id, latestScan);
  }, [latestScan, myShip, session, snapshot]);

  const visibleRows = useMemo(() => {
    return sortOverviewRows(filterOverviewRows(overviewRows, overviewFilter), sort);
  }, [overviewFilter, overviewRows, sort]);

  const selectedRow = useMemo(() => {
    if (selection === null) {
      return null;
    }
    return overviewRows.find((row) => sameSelection(row, selection)) ?? null;
  }, [overviewRows, selection]);

  const selectedAsteroidId =
    selectedRow?.kind === "asteroid" ? selectedRow.id : selectedRow?.asteroidId;

  const selectedSurfaceDeposits = useMemo(() => {
    if (snapshot === null || selectedAsteroidId === undefined) {
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

  // Stable identity for the world objects handed to the 3D scene. The asteroid field
  // is static, so its array reference only changes when the visible set actually
  // changes (a cell crossing) — not on every 30Hz delta that merely moved a ship.
  // Keying off snapshot.asteroids (preserved by reference across deltas that don't
  // touch it) keeps the instanced field from rebuilding its matrices every tick.
  const visibleAsteroids = useMemo(
    () => (snapshot === null ? [] : snapshot.asteroids.filter((asteroid) => asteroid.discovered)),
    [snapshot?.asteroids],
  );
  const visibleStructures = useMemo(
    () =>
      snapshot === null ? [] : snapshot.structures.filter((structure) => structure.discovered),
    [snapshot?.structures],
  );

  useEffect(() => {
    if (snapshot === null) {
      return;
    }
    const nextIds = new Set(snapshot.chat.map((message) => message.id));
    const added = snapshot.chat.filter((message) => !previousChatIdsRef.current.has(message.id));
    previousChatIdsRef.current = nextIds;
    if (added.length === 0) {
      return;
    }
    const fromOthers = added.some((message) => message.fromPilotId !== session?.pilot.id);
    if (fromOthers) {
      audio.engine.playOneShot("comms");
    }
    const commsOpen = layout.comms.open && focusedWindow === "comms";
    if (commsOpen) {
      setUnreadComms(0);
    } else {
      setUnreadComms((current) => current + added.length);
    }
  }, [focusedWindow, layout.comms.open, snapshot]);

  if (session === null || snapshot === null || myShip === null || meCard === null) {
    return (
      <main className="boot" data-testid="boot-screen">
        <div className="boot-mark">H</div>
        <div>Acquiring station uplink</div>
      </main>
    );
  }

  const contextMenuRow =
    contextMenu?.target === null || contextMenu?.target === undefined
      ? null
      : (overviewRows.find((row) => sameSelection(row, contextMenu.target!)) ?? null);
  const canUse = session !== null && myShip !== null;
  const effectiveThrottle = keyboardThrottle !== 0 ? keyboardThrottle : throttle;

  return (
    <main
      className="app-shell"
      data-testid="haystack-app"
      data-flight-mode={flightMode}
      data-flight-input-scale={flightInputScale.toFixed(4)}
      data-throttle={effectiveThrottle.toFixed(2)}
      data-owned-x={myShip.position.x.toFixed(3)}
      data-owned-y={myShip.position.y.toFixed(3)}
      data-owned-z={myShip.position.z.toFixed(3)}
      data-prediction-tick={predictionRef.current.currentPredictionTick}
      data-ack-tick={predictionRef.current.lastAcknowledgedTick}
    >
      <WorldView
        rows={overviewRows}
        myShip={myShip}
        asteroids={visibleAsteroids}
        structures={visibleStructures}
        ships={snapshot.ships}
        selected={selection}
        waypoint={waypoint}
        flightMode={flightMode}
        mouseDeflection={mouseDeflection}
        flightInputScale={flightInputScale}
        flashlightOn={flashlightOn}
        scanNonce={scanNonce}
        stageRef={stageRef}
        onSelect={selectTarget}
        onContextMenu={openContextMenu}
        onRequestFlightLock={requestFlightLock}
        audioContext={audio.unlocked ? audio.engine.getContext() : null}
        audioVolume={spatialMasterVolume(audio.mix)}
      />

      <TopRail
        snapshot={snapshot}
        myShip={myShip}
        flightMode={flightMode}
        throttle={effectiveThrottle}
        cruiseLock={cruiseLock}
        error={error}
      />
      <Neocom
        layout={layout}
        unreadComms={unreadComms}
        onToggle={toggleWindow}
        onReset={resetLayout}
      />

      <div className="window-layer">
        {windowDefinitions.map((definition) => {
          const state = layout[definition.key];
          if (!state.open) {
            return null;
          }
          return (
            <WindowFrame
              key={definition.key}
              definition={definition}
              state={state}
              focused={focusedWindow === definition.key}
              onFocus={() => focusWindow(definition.key)}
              onPatch={(patch) => patchWindow(definition.key, patch)}
              onClose={() => patchWindow(definition.key, { open: false })}
            >
              {definition.key === "flight" ? (
                <FlightWindow
                  myShip={myShip}
                  flightMode={flightMode}
                  throttle={effectiveThrottle}
                  cruiseLock={cruiseLock}
                  canUse={canUse}
                  onRequestFlightLock={requestFlightLock}
                  onThrust={sendFlightCommand}
                  onThrottleDown={() => adjustFlightThrottle(-throttleStep, true)}
                  onThrottleZero={() => setFlightThrottle(0, true)}
                  onThrottleUp={() => adjustFlightThrottle(throttleStep, true)}
                  onBoost={sendBoostInput}
                  onCruiseToggle={() => toggleFlightCruiseLock(true)}
                  onResetToOrigin={resetToOrigin}
                />
              ) : definition.key === "scanner" ? (
                <ScannerWindow
                  rows={visibleRows}
                  selected={selection}
                  sort={sort}
                  filter={overviewFilter}
                  scanMode={scanMode}
                  loading={isBusy("scan")}
                  onSort={sortBy}
                  onFilter={setOverviewFilter}
                  onScanMode={setScanMode}
                  onScan={() => runScan()}
                  onSelect={selectTarget}
                  onContextMenu={openContextMenu}
                />
              ) : definition.key === "cargo" ? (
                <CargoWindow
                  snapshot={snapshot}
                  myShip={myShip}
                  selectedAsteroidId={selectedAsteroidId}
                  deposits={selectedSurfaceDeposits}
                  canUse={canUse}
                  busyActions={busyActions}
                  onMine={mineDeposit}
                  onSell={sellAllCargo}
                />
              ) : definition.key === "comms" ? (
                <CommsWindow
                  snapshot={snapshot}
                  me={meCard}
                  channel={chatChannel}
                  targetPilotId={chatTargetPilotId}
                  draft={chatDraft}
                  messages={visibleChat}
                  busy={isBusy("send-chat")}
                  onChannel={setChatChannel}
                  onTarget={setChatTargetPilotId}
                  onDraft={setChatDraft}
                  onSend={sendChat}
                />
              ) : definition.key === "character" ? (
                <CharacterWindow
                  snapshot={snapshot}
                  me={meCard}
                  myShip={myShip}
                  onShowInfo={openShowInfo}
                />
              ) : (
                <BasesWindow
                  snapshot={snapshot}
                  myShip={myShip}
                  canUse={canUse}
                  busyActions={busyActions}
                  fieldStats={fieldStats}
                  onDeploy={deployHab}
                  onInspectField={inspectField}
                  onUpgrade={upgrade}
                />
              )}
            </WindowFrame>
          );
        })}
      </div>

      <HudCluster
        myShip={myShip}
        canUse={canUse}
        flightMode={flightMode}
        throttle={effectiveThrottle}
        cruiseLock={cruiseLock}
        onThrust={sendFlightCommand}
        onThrottleDown={() => adjustFlightThrottle(-throttleStep, true)}
        onThrottleZero={() => setFlightThrottle(0, true)}
        onThrottleUp={() => adjustFlightThrottle(throttleStep, true)}
        onBoost={sendBoostInput}
        onCruiseToggle={() => toggleFlightCruiseLock(true)}
      />
      <SelectedItemPanel
        row={selectedRow}
        snapshot={snapshot}
        markerActive={waypoint !== null}
        onShowInfo={() => selectedRow !== null && openShowInfo(selectedRow)}
        onScan={() =>
          selectedRow?.kind === "asteroid" ? runScan(selectedRow.id) : runScan(selectedAsteroidId)
        }
        onMine={mineSelectedDeposit}
        onSetFocus={() =>
          selectedRow?.kind === "asteroid" && setSelection({ kind: "asteroid", id: selectedRow.id })
        }
        onSetMarker={() => selectedRow !== null && setMarker(selectedRow)}
        onClearMarker={() => setWaypoint(null)}
        onInspectBase={openBases}
      />

      {showInfoTarget !== null ? (
        <ShowInfoCard
          target={showInfoTarget}
          snapshot={snapshot}
          rows={overviewRows}
          onClose={() => setShowInfoTarget(null)}
        />
      ) : null}

      {contextMenu !== null ? (
        <ContextMenu
          state={contextMenu}
          row={contextMenuRow}
          markerActive={waypoint !== null}
          onClose={() => setContextMenu(null)}
          onSelect={selectTarget}
          onShowInfo={openShowInfo}
          onScan={(row) => runScan(row.kind === "asteroid" ? row.id : row.asteroidId)}
          onMine={() => contextMenuRow?.kind === "deposit" && mineDepositById(contextMenuRow.id)}
          onSetMarker={setMarker}
          onClearSelection={() => setSelection(null)}
          onClearMarker={() => setWaypoint(null)}
          onDeployBase={deployHab}
          onPulseScan={() => runScan()}
          onOpenDm={openDmFor}
          onInspectBase={openBases}
        />
      ) : null}
      <AudioControls mix={audio.mix} unlocked={audio.unlocked} onChange={audio.setMix} />
    </main>
  );

  async function refreshSnapshot(pilotId: string): Promise<void> {
    try {
      const world = await getWorld(pilotId);
      setSnapshot((current) => {
        const predictedShip = predictedShipForAuthoritativeMerge();
        if (predictedShip === null) {
          resetPredictionFromSnapshot(world, pilotId);
        }
        const merged = mergeWorldSnapshotForOwnedPrediction(current, world, pilotId, predictedShip);
        fieldDeriverRef.current.setSeeded(world.asteroids);
        return withDerivedField(merged, fieldDeriverRef.current, pilotId);
      });
    } catch (nextError: unknown) {
      setError(messageFrom(nextError));
    }
  }

  function predictedShipForAuthoritativeMerge(): Ship | null {
    return predictionRef.current.bufferedInputCount > 0 ? predictionRef.current.currentShip : null;
  }

  function resetPredictionFromSnapshot(world: WorldSnapshot, pilotId: string): void {
    const ownedShip = world.ships.find((ship) => ship.pilotId === pilotId) ?? null;
    if (ownedShip !== null) {
      predictionRef.current.reset(ownedShip);
      flightRenderStore.resetOwned(ownedShip);
    }
  }

  function ensurePredictionSeed(pilotId: string): void {
    if (predictionRef.current.currentShip !== null) {
      return;
    }
    const ownedShip = myShipRef.current;
    if (ownedShip !== null && ownedShip.pilotId === pilotId) {
      predictionRef.current.reset(ownedShip);
      flightRenderStore.resetOwned(ownedShip);
    }
  }

  function pushRemotesToStore(ships: Ship[], ownPilotId: string, serverTimeMs: number): void {
    for (const ship of ships) {
      if (ship.pilotId === ownPilotId) {
        continue;
      }
      flightRenderStore.pushRemote(ship.pilotId, serverTimeMs, ship.position, ship.orientation);
    }
  }

  function isBusy(action: string): boolean {
    return busyActions.has(action);
  }

  async function withAction(action: string, task: () => Promise<void>): Promise<void> {
    if (busyActions.has(action)) {
      return;
    }
    setBusyActions((current) => new Set(current).add(action));
    setError(null);
    try {
      await task();
      if (session !== null) {
        await refreshSnapshot(session.pilot.id);
      }
    } catch (nextError: unknown) {
      setError(messageFrom(nextError));
    } finally {
      setBusyActions((current) => {
        const next = new Set(current);
        next.delete(action);
        return next;
      });
    }
  }

  function focusWindow(key: WindowKey): void {
    setFocusedWindow(key);
    if (key === "comms") {
      setUnreadComms(0);
    }
    setLayout((current) => {
      const target = current[key];
      const maxZ = Math.max(...windowDefinitions.map((definition) => current[definition.key].z));
      if (target.z > maxZ) {
        return current;
      }
      return {
        ...current,
        [key]: {
          ...target,
          z: maxZ + 1,
        },
      };
    });
  }

  function patchWindow(key: WindowKey, patch: Partial<WindowState>): void {
    setLayout((current) => patchWindowState(current, key, patch));
  }

  function toggleWindow(key: WindowKey): void {
    audio.engine.playOneShot("uiClick");
    const nextOpen = !layout[key].open;
    patchWindow(key, { open: nextOpen, minimized: false });
    if (nextOpen) {
      focusWindow(key);
    }
  }

  function resetLayout(): void {
    if (session !== null) {
      window.localStorage.removeItem(layoutKey(session.pilot.id));
    }
    setLayout(createDefaultLayout());
    setFocusedWindow("scanner");
  }

  function sortBy(field: SortField): void {
    setSort((current) =>
      current.field === field
        ? { field, direction: current.direction === "asc" ? "desc" : "asc" }
        : { field, direction: "asc" },
    );
  }

  function sendFlightCommand(impulse: Vector3, stabilize = false): void {
    if (session === null) {
      return;
    }
    const command: ThrustCommand = stabilize
      ? { impulse, frame: "local", stabilize }
      : { impulse, frame: "local" };
    if (sendPredictedFlightCommand(session.pilot.id, command)) {
      return;
    }
    void withAction("thrust-rest", async () => {
      await sendThrust(session.pilot.id, command);
    });
  }

  function resetToOrigin(): void {
    const currentSession = sessionRef.current ?? session;
    if (currentSession === null) {
      return;
    }
    const pilotId = currentSession.pilot.id;
    void withAction("reset-origin", async () => {
      const ship = await resetShip(pilotId);
      // Snap the local prediction + render store to the authoritative origin so the camera does
      // not fight the teleport, and stop any in-flight input from re-accelerating the ship.
      predictionRef.current.reset(ship);
      flightRenderStore.resetOwned(ship);
      clearFlightInput();
      flightStateRef.current = { throttle: 0, cruiseLock: false };
      setThrottle(0);
      setCruiseLock(false);
      setSnapshot((current) =>
        current === null ? current : replaceOwnedShip(current, pilotId, ship),
      );
    });
  }

  function sendFlightInput(command: FlightInputCommand): void {
    const currentSession = sessionRef.current;
    if (currentSession === null) {
      return;
    }
    if (!sendPredictedFlightCommand(currentSession.pilot.id, command) && command.active !== false) {
      setError("World stream is unavailable for continuous flight input.");
    }
  }

  function sendPredictedFlightCommand(
    pilotId: string,
    command: ThrustCommand | FlightInputCommand,
  ): boolean {
    ensurePredictionSeed(pilotId);
    const clientTick = predictionRef.current.currentPredictionTick + 1;
    const sent = sendWorldStreamMessage(streamRef.current, {
      type: "input",
      pilotId,
      clientTick,
      command,
    });
    if (!sent) {
      return false;
    }
    const predicted = predictionRef.current.predict(command);
    if (predicted === null) {
      return true;
    }
    // The render store drives the 60fps owned-ship/camera transform every frame.
    flightRenderStore.setOwnedPredicted(predicted.ship);
    // Refresh React state (HUD, overview, data attributes) from the prediction
    // at ~20Hz instead of every input frame. Rendering no longer depends on
    // these commits, so this keeps the UI fresh without flooding the main thread
    // with re-renders that previously starved the animation loop.
    predictCommitRef.current += 1;
    if (predictCommitRef.current % 3 === 0) {
      setSnapshot((current) =>
        current === null ? current : replaceOwnedShip(current, pilotId, predicted.ship),
      );
    }
    return true;
  }

  function requestFlightLock(): void {
    const stage = stageRef.current;
    if (stage === null) {
      return;
    }
    flightModeRef.current = "flight";
    setFlightMode("flight");
    try {
      const lockRequest = stage.requestPointerLock();
      if (lockRequest instanceof Promise) {
        void lockRequest.catch(() => undefined);
      }
    } catch {
      // Keep keyboard flight mode active even when a browser denies pointer lock.
    }
  }

  function toggleFlightLock(): void {
    if (flightModeRef.current === "flight") {
      document.exitPointerLock();
      flightModeRef.current = "cursor";
      setFlightMode("cursor");
      return;
    }
    requestFlightLock();
  }

  function clearFlightInput(): void {
    heldKeysRef.current.clear();
    setKeyboardThrottle(0);
    mouseDeflectionRef.current = { x: 0, y: 0, z: 0 };
    setMouseDeflection({ x: 0, y: 0, z: 0 });
    oneShotRef.current = { boost: false };
  }

  function buildFlightInput(active: boolean): FlightInputCommand {
    const oneShot = oneShotRef.current;
    oneShotRef.current = { boost: false };
    const keys = heldKeysRef.current;
    const inputScale = active ? flightInputScaleRef.current : 1;
    const keyboardThrottleInput = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
    const rawThrottle =
      active && keyboardThrottleInput !== 0
        ? keyboardThrottleInput
        : flightStateRef.current.throttle;
    const commandThrottle = rawThrottle * inputScale;
    return {
      kind: "flight",
      throttle: commandThrottle,
      cruiseLock: flightStateRef.current.cruiseLock,
      active,
      strafe: active
        ? {
            x: (Number(keys.has("KeyD")) - Number(keys.has("KeyA"))) * inputScale,
            y:
              (Number(keys.has("Space")) -
                Number(keys.has("ControlLeft") || keys.has("ControlRight"))) *
              inputScale,
            z: 0,
          }
        : { x: 0, y: 0, z: 0 },
      rotation: active
        ? {
            x: mouseDeflectionRef.current.x * inputScale,
            y: mouseDeflectionRef.current.y * inputScale,
            z: (Number(keys.has("KeyQ")) - Number(keys.has("KeyE"))) * inputScale,
          }
        : { x: 0, y: 0, z: 0 },
      ...(active && keys.has("KeyX") ? { stabilize: true } : {}),
      ...(oneShot.boost ? { boost: true } : {}),
    };
  }

  function syncKeyboardThrottle(): void {
    const keys = heldKeysRef.current;
    setKeyboardThrottle(Number(keys.has("KeyW")) - Number(keys.has("KeyS")));
  }

  function setFlightInputScaleByWheel(deltaY: number): void {
    if (deltaY === 0) {
      return;
    }
    const next = clamp(
      flightInputScaleRef.current * 2 ** (-deltaY / flightInputScaleWheelDivisor),
      flightInputScaleMin,
      flightInputScaleMax,
    );
    const rounded = Math.round(next * 10000) / 10000;
    flightInputScaleRef.current = rounded;
    setFlightInputScale(rounded);
  }

  function selectTarget(next: Selection | null): void {
    if (next !== null) {
      audio.engine.playOneShot("targetLock");
    }
    setSelection(next);
  }

  function setFlightThrottle(value: number, sendNow = false): void {
    if (value === 0 && sendNow) {
      audio.engine.playOneShot("brake");
    }
    const next = clamp(value, -1, 1);
    setThrottle(next);
    flightStateRef.current = { ...flightStateRef.current, throttle: next };
    if (sendNow) {
      sendFlightInput(buildFlightInput(flightModeRef.current === "flight"));
    }
  }

  function adjustFlightThrottle(delta: number, sendNow = false): void {
    setFlightThrottle(flightStateRef.current.throttle + delta, sendNow);
  }

  function toggleFlightCruiseLock(sendNow = false): void {
    const next = !flightStateRef.current.cruiseLock;
    setCruiseLock(next);
    flightStateRef.current = { ...flightStateRef.current, cruiseLock: next };
    if (sendNow) {
      sendFlightInput(buildFlightInput(flightModeRef.current === "flight"));
    }
  }

  function sendBoostInput(): void {
    audio.engine.playOneShot("boost");
    oneShotRef.current.boost = true;
    sendFlightInput(buildFlightInput(flightModeRef.current === "flight"));
  }

  function runScan(targetAsteroidId = selectedAsteroidId): void {
    audio.engine.playOneShot("scanHonk");
    if (session === null) {
      return;
    }
    void withAction("scan", async () => {
      const report = await pulseScan(session.pilot.id, {
        mode: scanMode,
        ...(targetAsteroidId !== undefined && targetAsteroidId.length > 0
          ? { targetAsteroidId }
          : {}),
      });
      setLatestScan(report);
      if (selection === null) {
        const firstInspectable = report.hits.find((hit) => hit.kind !== "pocket");
        if (firstInspectable !== undefined) {
          setSelection({ id: firstInspectable.id, kind: firstInspectable.kind });
        }
      }
    });
  }

  function mineDeposit(deposit: Deposit): void {
    if (session === null) {
      return;
    }
    void withAction(`mine-${deposit.id}`, async () => {
      audio.engine.setMining(true);
      try {
        await mine(session.pilot.id, {
          asteroidId: deposit.asteroidId,
          depositId: deposit.id,
        });
      } finally {
        audio.engine.setMining(false);
      }
    });
  }

  function mineDepositById(depositId: string): void {
    const deposit = snapshot?.deposits.find((candidate) => candidate.id === depositId);
    if (deposit !== undefined) {
      mineDeposit(deposit);
    }
  }

  function mineSelectedDeposit(): void {
    if (selectedRow?.kind !== "deposit") {
      return;
    }
    mineDepositById(selectedRow.id);
  }

  function sellAllCargo(): void {
    if (session === null) {
      return;
    }
    void withAction("sell-cargo", async () => {
      await sellCargo(session.pilot.id, {});
    });
  }

  function deployHab(): void {
    audio.engine.playOneShot("chime");
    if (session === null) {
      return;
    }
    void withAction("deploy-base", async () => {
      await buildBase(session.pilot.id, {
        name: `${session.pilot.callsign} Cache HAB`,
        hidden: true,
      });
    });
  }

  function inspectField(): void {
    if (session === null) {
      return;
    }
    void withAction("field-index", async () => {
      const diagnostic = await fieldDiagnostic(session.pilot.id);
      setFieldStats(diagnostic);
    });
  }

  function upgrade(system: UpgradeSystem): void {
    if (session === null) {
      return;
    }
    void withAction(`upgrade-${system}`, async () => {
      await upgradeShip(session.pilot.id, { system });
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
    const body = chatDraft.trim();
    setChatDraft("");
    void withAction("send-chat", async () => {
      await postChat({
        channel: chatChannel,
        fromPilotId: session.pilot.id,
        body,
        ...(chatChannel === "dm" ? { toPilotId: chatTargetPilotId } : {}),
      });
    });
  }

  function openShowInfo(target: Selection): void {
    setShowInfoTarget(target);
  }

  function setMarker(row: OverviewRow): void {
    if (row.position === null) {
      return;
    }
    setWaypoint({
      id: row.id,
      kind: row.kind,
      name: row.name,
      position: row.position,
    });
  }

  function openDmFor(target: Selection): void {
    if (target.kind !== "ship") {
      return;
    }
    setChatChannel("dm");
    setChatTargetPilotId(target.id);
    patchWindow("comms", { open: true, minimized: false });
    focusWindow("comms");
  }

  function openBases(): void {
    patchWindow("bases", { open: true, minimized: false });
    focusWindow("bases");
  }

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, target: Selection | null): void {
    event.preventDefault();
    event.stopPropagation();
    if (target !== null) {
      setSelection(target);
    }
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
