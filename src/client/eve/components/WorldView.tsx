import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DodecahedronGeometry,
  IcosahedronGeometry,
  Matrix4,
  Object3D,
  OctahedronGeometry,
  Quaternion as ThreeQuaternion,
  TetrahedronGeometry,
  Vector3 as ThreeVector3,
  type Camera,
} from "three";
import type { Asteroid, Ship, Structure, Vector3 } from "../../../shared/types";
import {
  autoRotationStabilizerThresholdRadians,
  shipMaxAngularRate,
} from "../../../shared/ship-motion";
import type { FlightMode, OverviewRow, Selection, Waypoint } from "../types";
import { flightInputScaleMax, flightInputScaleMin } from "../constants";
import { clamp, formatDistance, toScene, vectorMagnitude } from "../vector";
import { sameSelection } from "../overview";
import { flightRenderStore } from "../renderStore";
import { fogColor, fogFar, fogNear } from "../lighting";
import { getRenderDebugControls, renderStats } from "../render-stats";
import { AudioListenerRig, RemoteShipAudio } from "./SpatialAudio";
import { ShipFlashlight, SunDisc, SunLight } from "./SceneLighting";
// WebGPU-resident asteroid field (docs/gpu-asteroids-architecture.md §8). The game boots on
// WebGPURenderer via this gl factory; the field is GPU-resident (base uploaded from the CPU
// derive, pos = base + overlay, zero-copy positionNode). There is no WebGL fallback (§1.1/§5).
import { makeWebGPUFactory } from "../gpu/renderer-factory";
import { ScenePostProcessing } from "./ScenePostProcessing";
import { makeLodAsteroidMaterial, originMeters } from "../gpu/kernels/render-node";
import { frameCounter, genFieldOverlay } from "../gpu/kernels/overlay";
import { makeCullPipeline } from "../gpu/kernels/cull";
import {
  collisionDt,
  collOffset,
  collVel,
  gridOrigin,
  makeCollisionPipeline,
  snapGridOrigin,
} from "../gpu/kernels/collide";
import { COLLISION_WINDOW_METERS } from "../gpu/collide-cpu";
import { deriveGravityWells, WELL_SIGMA_METERS } from "../gpu/wells";
import {
  backingArrayOf,
  backingU32Of,
  base,
  MAX_RESIDENT,
  packAttr,
  slotMeta,
} from "../gpu/buffers";
import { markRangesForUpload } from "../gpu/base-derive";
import { FieldRingStream, mergeDirtyToRanges } from "../gpu/ring-stream";
// NOTE: the WebGL @react-three/postprocessing stack (ScanPulse + Bloom + ACES) cannot run under
// WebGPURenderer; it is removed here and ported to the three-native TSL PostProcessing in step 2.

// Live owned-ship origin used to position every world object relative to the
// camera. Read from the render store (smoothed, 60fps) when seeded, otherwise
// the latest React snapshot value.
function renderOrigin(fallback: Vector3): Vector3 {
  return flightRenderStore.hasOwned() ? flightRenderStore.ownedRenderPosition() : fallback;
}

type ScreenPoint = {
  x: number;
  y: number;
  visible: boolean;
};

type SelectionArrow = {
  angleDeg: number;
  strength: number;
};

type SelectionBox = {
  x: number;
  y: number;
  sizePct: number;
  distance: number;
};

export function WorldView({
  bracketRows,
  selectedRow,
  asteroids,
  structures,
  ships,
  myShip,
  selected,
  waypoint,
  flightMode,
  mouseDeflection,
  flightInputScale,
  flashlightOn,
  scanNonce,
  stageRef,
  onSelect,
  onContextMenu,
  onRequestFlightLock,
  audioContext,
  audioVolume,
}: {
  // Pre-materialized by EveApp's overview model: the nearest positioned rows for the
  // in-world brackets, and the selected row (resolved by key, so it is correct even when
  // the selected object is far away / outside the virtualized overview window). The full
  // overview is never materialized as a 50k-row array here anymore.
  bracketRows: OverviewRow[];
  selectedRow: OverviewRow | null;
  asteroids: Asteroid[];
  structures: Structure[];
  ships: Ship[];
  myShip: Ship;
  selected: Selection | null;
  waypoint: Waypoint | null;
  flightMode: FlightMode;
  mouseDeflection: { x: number; y: number; z: number };
  flightInputScale: number;
  flashlightOn: boolean;
  scanNonce: number;
  stageRef: RefObject<HTMLDivElement | null>;
  onSelect: (selection: Selection) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, target: Selection | null) => void;
  onRequestFlightLock: () => void;
  audioContext: AudioContext | null;
  audioVolume: number;
}): ReactNode {
  const [screenPoints, setScreenPoints] = useState<Record<string, ScreenPoint>>({});
  const [selectionArrow, setSelectionArrow] = useState<SelectionArrow | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const angularSpeed = vectorMagnitude(myShip.angularVelocity);
  const angularStable = angularSpeed <= autoRotationStabilizerThresholdRadians;

  return (
    <div
      className={`world-stage ${flightMode === "flight" ? "flight-mode" : "cursor-mode"}`}
      ref={stageRef}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget || event.target instanceof HTMLCanvasElement) {
          onRequestFlightLock();
        }
      }}
      onContextMenu={(event) => onContextMenu(event, null)}
    >
      <Canvas
        data-testid="world-canvas"
        gl={makeWebGPUFactory()}
        shadows
        camera={{ position: [0, 0.12, 0], fov: 68, near: 0.01, far: 20000 }}
        dpr={[1, 1.5]}
      >
        <RenderDriver fallbackShip={myShip} />
        <SceneProjection
          rows={bracketRows}
          myShip={myShip}
          waypoint={waypoint}
          selectedRow={selectedRow}
          asteroids={asteroids}
          onProject={setScreenPoints}
          onArrow={setSelectionArrow}
          onBox={setSelectionBox}
        />
        <color attach="background" args={["#03040a"]} />
        <fog attach="fog" args={[fogColor, fogNear, fogFar]} />
        <SunLight />
        <ConditionalListenerRig ctx={audioContext} volume={audioVolume}>
          <group>
            <SunDisc />
            <ShipFlashlight fallbackOrientation={myShip.orientation} on={flashlightOn} />
            <GridStars />
            <InstancedAsteroids asteroids={asteroids} fallbackOrigin={myShip.position} />
            {structures.map((structure) => (
              <StructureMesh
                key={structure.id}
                structure={structure}
                fallbackOrigin={myShip.position}
              />
            ))}
            {ships
              .filter((ship) => ship.pilotId !== myShip.pilotId)
              .map((ship) => (
                <OtherShipMesh
                  key={ship.pilotId}
                  ship={ship}
                  fallbackOrigin={myShip.position}
                  audioContext={audioContext}
                />
              ))}
          </group>
        </ConditionalListenerRig>
        <ScenePostProcessing scanNonce={scanNonce} />
      </Canvas>
      <div
        className="reticle"
        data-testid="hud-reticle"
        data-angular-stable={angularStable}
        data-angular-speed-degrees-per-second={((angularSpeed * 180) / Math.PI).toFixed(2)}
      />
      <FlightInputScaleMeter scale={flightInputScale} />
      <FlightVectorLayer
        velocityPoint={screenPoints["velocity"]}
        reverseVelocityPoint={screenPoints["reverseVelocity"]}
        angularVelocity={myShip.angularVelocity}
        flightInputScale={flightInputScale}
        flightMode={flightMode}
        mouseDeflection={mouseDeflection}
      />
      <SceneBrackets
        rows={bracketRows}
        screenPoints={screenPoints}
        selected={selected}
        waypoint={waypoint}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
      />
      <SelectionBoxLayer box={selectionBox} />
      <SelectionArrowLayer arrow={selectionArrow} />
    </div>
  );
}

function SceneBrackets({
  rows,
  screenPoints,
  selected,
  waypoint,
  onSelect,
  onContextMenu,
}: {
  rows: OverviewRow[];
  screenPoints: Record<string, ScreenPoint>;
  selected: Selection | null;
  waypoint: Waypoint | null;
  onSelect: (selection: Selection) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, target: Selection | null) => void;
}): ReactNode {
  const waypointPoint = screenPoints["waypoint"];
  return (
    <div className="bracket-layer" aria-hidden={false}>
      {rows.map((row) => {
        const point = screenPoints[row.key];
        if (point === undefined || !point.visible) {
          return null;
        }
        return (
          <button
            type="button"
            key={row.key}
            className="scene-bracket"
            data-testid="scene-bracket"
            data-object-id={row.id}
            data-object-kind={row.kind}
            data-distance-m={row.distance}
            data-selected={selected !== null && sameSelection(row, selected)}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            onClick={() => onSelect(row)}
            onContextMenu={(event) => onContextMenu(event, row)}
          >
            <span>{row.name}</span>
            <small>{formatDistance(row.distance)}</small>
          </button>
        );
      })}
      {waypoint !== null && waypointPoint?.visible === true ? (
        <div
          className="waypoint-marker"
          data-testid="waypoint-marker"
          style={{
            left: `${waypointPoint.x}%`,
            top: `${waypointPoint.y}%`,
          }}
        >
          waypoint: {waypoint.name}
        </div>
      ) : null}
    </div>
  );
}

function SceneProjection({
  rows,
  myShip,
  waypoint,
  selectedRow,
  asteroids,
  onProject,
  onArrow,
  onBox,
}: {
  rows: OverviewRow[];
  myShip: Ship;
  waypoint: Waypoint | null;
  selectedRow: OverviewRow | null;
  asteroids: Asteroid[];
  onProject: (points: Record<string, ScreenPoint>) => void;
  onArrow: (arrow: SelectionArrow | null) => void;
  onBox: (box: SelectionBox | null) => void;
}): null {
  const projected = useMemo(() => new ThreeVector3(), []);
  const radiusScratch = useMemo(() => new ThreeVector3(), []);
  const viewScratch = useMemo(() => new ThreeVector3(), []);
  const lastSignature = useRef("");
  const lastArrowSig = useRef("none");
  const lastBoxSig = useRef("none");
  const selectedRowRef = useRef(selectedRow);
  selectedRowRef.current = selectedRow;
  // id -> asteroid lookup so the per-frame selection-box projection is O(1) instead of a
  // linear scan over the whole visible field each frame. Only built when an asteroid is
  // actually selected — otherwise this 100k-entry map would be rebuilt on every cell cross
  // (a derived-set change) for nothing, adding ~6 ms of needless field work per crossing.
  const selectionNeedsAsteroidMap = selectedRow?.kind === "asteroid";
  const asteroidById = useMemo(() => {
    const map = new Map<string, Asteroid>();
    if (selectionNeedsAsteroidMap) {
      for (const asteroid of asteroids) {
        map.set(asteroid.id, asteroid);
      }
    }
    return map;
  }, [asteroids, selectionNeedsAsteroidMap]);
  const asteroidByIdRef = useRef(asteroidById);
  asteroidByIdRef.current = asteroidById;

  useFrame(({ camera }) => {
    const origin = renderOrigin(myShip.position);
    const next: Record<string, ScreenPoint> = {};
    for (const row of rows) {
      if (row.position === null) {
        continue;
      }
      next[row.key] = projectWorldPoint(row.position, origin, camera, projected);
    }
    if (waypoint !== null) {
      next["waypoint"] = projectWorldPoint(waypoint.position, origin, camera, projected);
    }
    const speed = vectorMagnitude(myShip.velocity);
    if (speed > 0.05) {
      const projectionDistance = Math.max(1800, Math.min(14000, speed * 42));
      const velocityDirection = {
        x: myShip.velocity.x / speed,
        y: myShip.velocity.y / speed,
        z: myShip.velocity.z / speed,
      };
      next["velocity"] = projectWorldPointClamped(
        {
          x: origin.x + velocityDirection.x * projectionDistance,
          y: origin.y + velocityDirection.y * projectionDistance,
          z: origin.z + velocityDirection.z * projectionDistance,
        },
        origin,
        camera,
        projected,
      );
      next["reverseVelocity"] = projectWorldPoint(
        {
          x: origin.x - velocityDirection.x * projectionDistance,
          y: origin.y - velocityDirection.y * projectionDistance,
          z: origin.z - velocityDirection.z * projectionDistance,
        },
        origin,
        camera,
        projected,
      );
    }

    let nextArrow: SelectionArrow | null = null;
    const currentSelectedRow = selectedRowRef.current;
    if (currentSelectedRow !== null) {
      const target =
        currentSelectedRow.position !== null
          ? currentSelectedRow.position
          : bearingPoint(origin, currentSelectedRow.bearing);
      if (target !== null) {
        nextArrow = projectSelectionArrow(target, origin, camera, projected, viewScratch);
      }
    }
    const arrowSig =
      nextArrow === null
        ? "none"
        : `${Math.round(nextArrow.angleDeg)}:${nextArrow.strength.toFixed(2)}`;
    if (arrowSig !== lastArrowSig.current) {
      lastArrowSig.current = arrowSig;
      onArrow(nextArrow);
    }

    let nextBox: SelectionBox | null = null;
    if (currentSelectedRow !== null && currentSelectedRow.position !== null) {
      nextBox = projectSelectionBox(
        currentSelectedRow,
        asteroidByIdRef.current,
        origin,
        camera,
        projected,
        radiusScratch,
      );
    }
    const boxSig =
      nextBox === null
        ? "none"
        : `${nextBox.x.toFixed(1)}:${nextBox.y.toFixed(1)}:${nextBox.sizePct.toFixed(2)}`;
    if (boxSig !== lastBoxSig.current) {
      lastBoxSig.current = boxSig;
      onBox(nextBox);
    }

    const signature = Object.entries(next)
      .map(([key, point]) => `${key}:${point.visible ? 1 : 0}:${point.x}:${point.y}`)
      .join("|");
    if (signature !== lastSignature.current) {
      lastSignature.current = signature;
      onProject(next);
    }
  });

  return null;
}

function FlightVectorLayer({
  velocityPoint,
  reverseVelocityPoint,
  angularVelocity,
  flightInputScale,
  flightMode,
  mouseDeflection,
}: {
  velocityPoint: ScreenPoint | undefined;
  reverseVelocityPoint: ScreenPoint | undefined;
  angularVelocity: { x: number; y: number; z: number };
  flightInputScale: number;
  flightMode: FlightMode;
  mouseDeflection: { x: number; y: number; z: number };
}): ReactNode {
  const yaw = mouseDeflection.y;
  const pitch = mouseDeflection.x;
  const aimX = 50 - yaw * 24;
  const aimY = 50 - pitch * 24;
  const dx = aimX - 50;
  const dy = aimY - 50;
  const aimDistance = Math.sqrt(dx * dx + dy * dy);
  const showAim = flightMode === "flight" && aimDistance > 1.2;
  const torque = angularTorqueIndicator(angularVelocity, flightInputScale);
  const roll = angularRollIndicator(angularVelocity.z, flightInputScale);
  const stabilizerRing = angularStabilizerRing(flightInputScale);
  const angularStable = vectorMagnitude(angularVelocity) <= autoRotationStabilizerThresholdRadians;

  return (
    <div className="flight-vector-layer" aria-hidden="true">
      <svg
        className="angular-stabilizer-ring"
        data-testid="angular-stabilizer-ring"
        data-radius-percent={stabilizerRing.radius.toFixed(1)}
        data-threshold-degrees-per-second={stabilizerRing.thresholdDegreesPerSecond.toFixed(1)}
        data-angular-stable={angularStable}
        focusable="false"
      >
        <circle cx="50%" cy="50%" r={`${stabilizerRing.radius}%`} />
      </svg>
      {velocityPoint !== undefined ? (
        <div
          className="velocity-vector"
          data-testid="velocity-vector"
          data-clamped={!velocityPoint.visible}
          style={{ left: `${velocityPoint.x}%`, top: `${velocityPoint.y}%` }}
        />
      ) : null}
      {reverseVelocityPoint?.visible === true ? (
        <div
          className="velocity-vector reverse-velocity-vector"
          data-testid="reverse-velocity-vector"
          style={{ left: `${reverseVelocityPoint.x}%`, top: `${reverseVelocityPoint.y}%` }}
        />
      ) : null}
      {torque !== null ? (
        <>
          <svg
            className="angular-torque-line"
            data-testid="angular-torque-line"
            data-capped={torque.capped}
            data-angular-stable={torque.stable}
            data-speed-degrees-per-second={torque.speedDegreesPerSecond.toFixed(2)}
            data-max-degrees-per-second={torque.maxDegreesPerSecond.toFixed(2)}
            style={angularCaptureStyle(torque.captureBlend)}
            focusable="false"
          >
            <line x1="50%" y1="50%" x2={`${torque.x}%`} y2={`${torque.y}%`} />
            {torque.capped ? (
              <line
                className="angular-torque-cap"
                data-testid="angular-torque-cap"
                x1={`${torque.capStartX}%`}
                y1={`${torque.capStartY}%`}
                x2={`${torque.capEndX}%`}
                y2={`${torque.capEndY}%`}
              />
            ) : (
              <circle
                className="angular-torque-pip"
                data-testid="angular-torque-pip"
                cx={`${torque.x}%`}
                cy={`${torque.y}%`}
                r="3"
              />
            )}
          </svg>
          <div
            className="angular-speed-label"
            data-testid="angular-speed-label"
            style={{
              left: `${torque.labelX}%`,
              top: `${torque.labelY}%`,
              transform: `translate(-50%, -50%) rotate(${torque.labelAngle}deg)`,
            }}
          >
            {torque.degreesPerSecond}
          </div>
        </>
      ) : null}
      {roll !== null ? (
        <svg
          className="angular-roll-line"
          data-testid="angular-roll-line"
          data-roll-dir={roll.direction}
          data-capped={roll.capped}
          data-angular-stable={roll.stable}
          data-arc-degrees={roll.arcDegrees.toFixed(1)}
          data-speed-degrees-per-second={roll.speedDegreesPerSecond.toFixed(2)}
          data-max-degrees-per-second={roll.maxDegreesPerSecond.toFixed(2)}
          style={angularCaptureStyle(roll.captureBlend)}
          viewBox="0 0 100 100"
          focusable="false"
        >
          <path className="angular-roll-arc" d={roll.pathD} />
          {roll.capped ? (
            <polygon
              className="angular-roll-cap"
              data-testid="angular-roll-cap"
              points={roll.capPoints}
            />
          ) : (
            <circle
              className="angular-roll-pip"
              data-testid="angular-roll-pip"
              cx={roll.endX}
              cy={roll.endY}
              r="3.8"
            />
          )}
        </svg>
      ) : null}
      {showAim ? (
        <>
          <svg className="aim-delta-line" data-testid="aim-delta-line" focusable="false">
            <line x1="50%" y1="50%" x2={`${aimX}%`} y2={`${aimY}%`} />
          </svg>
          <div
            className="aim-delta-icon"
            data-testid="aim-delta-icon"
            style={{ left: `${aimX}%`, top: `${aimY}%` }}
          />
        </>
      ) : null}
    </div>
  );
}

function FlightInputScaleMeter({ scale }: { scale: number }): ReactNode {
  const position = clamp(scale, flightInputScaleMin, flightInputScaleMax) / flightInputScaleMax;
  return (
    <div
      className="flight-input-scale-meter"
      data-testid="flight-input-scale-meter"
      data-scale={scale.toFixed(4)}
      style={{ "--flight-input-scale": `${position * 100}%` } as CSSProperties}
    >
      <div className="flight-input-scale-track">
        <span data-testid="flight-input-scale-pip" />
        <small>{formatScalePercent(scale)}</small>
      </div>
    </div>
  );
}

function formatScalePercent(scale: number): string {
  const percent = scale * 100;
  if (percent < 1) {
    return `${percent.toFixed(1)}%`;
  }
  if (percent < 10) {
    return `${percent.toFixed(1)}%`;
  }
  return `${percent.toFixed(0)}%`;
}

function angularTorqueIndicator(
  angularVelocity: { x: number; y: number; z: number },
  flightInputScale: number,
): {
  x: number;
  y: number;
  capped: boolean;
  capStartX: number;
  capStartY: number;
  capEndX: number;
  capEndY: number;
  labelX: number;
  labelY: number;
  labelAngle: number;
  degreesPerSecond: string;
  speedDegreesPerSecond: number;
  maxDegreesPerSecond: number;
  stable: boolean;
  captureBlend: number;
} | null {
  const screenX = angularVelocity.y;
  const screenY = angularVelocity.x;
  const planarMagnitude = Math.sqrt(screenX * screenX + screenY * screenY);
  if (planarMagnitude <= 0.000001) {
    return null;
  }

  const directionX = screenX / planarMagnitude;
  const directionY = screenY / planarMagnitude;
  const maxDisplayRate = maxAngularDisplayRate(
    { x: angularVelocity.x, y: angularVelocity.y, z: 0 },
    flightInputScale,
  );
  const maxLength = 26;
  const normalizedLength = clamp(planarMagnitude / maxDisplayRate, 0, 1);
  const capped = normalizedLength >= 1;
  const length = normalizedLength * maxLength;
  const capSize = 2.4;
  const capX = -directionY * capSize;
  const capY = directionX * capSize;
  const lineAngle = (Math.atan2(directionY, directionX) * 180) / Math.PI;
  const labelAngle = lineAngle > 90 || lineAngle < -90 ? lineAngle + 180 : lineAngle;

  return {
    x: Math.round((50 + directionX * length) * 10) / 10,
    y: Math.round((50 + directionY * length) * 10) / 10,
    capped,
    capStartX: Math.round((50 + directionX * length - capX) * 10) / 10,
    capStartY: Math.round((50 + directionY * length - capY) * 10) / 10,
    capEndX: Math.round((50 + directionX * length + capX) * 10) / 10,
    capEndY: Math.round((50 + directionY * length + capY) * 10) / 10,
    labelX: Math.round((50 + directionX * Math.max(10, length * 0.58)) * 10) / 10,
    labelY: Math.round((50 + directionY * Math.max(10, length * 0.58)) * 10) / 10,
    labelAngle: Math.round(labelAngle * 10) / 10,
    degreesPerSecond: `${Math.round((planarMagnitude * 180) / Math.PI)} deg/s`,
    speedDegreesPerSecond: (planarMagnitude * 180) / Math.PI,
    maxDegreesPerSecond: (maxDisplayRate * 180) / Math.PI,
    stable: planarMagnitude <= autoRotationStabilizerThresholdRadians,
    captureBlend: angularCaptureBlend(planarMagnitude),
  };
}

function angularRollIndicator(
  rollVelocity: number,
  flightInputScale: number,
): {
  direction: "positive" | "negative";
  capped: boolean;
  pathD: string;
  endX: number;
  endY: number;
  capPoints: string;
  arcDegrees: number;
  speedDegreesPerSecond: number;
  maxDegreesPerSecond: number;
  stable: boolean;
  captureBlend: number;
} | null {
  const magnitude = Math.abs(rollVelocity);
  if (magnitude <= 0.000001) {
    return null;
  }

  const direction = rollVelocity >= 0 ? "positive" : "negative";
  const directionSign = direction === "positive" ? 1 : -1;
  const maxDisplayRate = maxAngularDisplayRate({ x: 0, y: 0, z: rollVelocity }, flightInputScale);
  const normalizedLength = clamp(magnitude / maxDisplayRate, 0, 1);
  const capped = normalizedLength >= 1;
  const maxArcDegrees = 300;
  const arcDegrees = normalizedLength * maxArcDegrees;
  const radius = 37;
  const startAngle = -90;
  const endAngle = startAngle + directionSign * arcDegrees;
  const start = pointOnCircle(50, 50, radius, startAngle);
  const end = pointOnCircle(50, 50, radius, endAngle);
  const largeArc = arcDegrees > 180 ? 1 : 0;
  const sweep = direction === "positive" ? 1 : 0;
  return {
    direction,
    capped,
    pathD: `M ${roundSvg(start.x)} ${roundSvg(start.y)} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${roundSvg(end.x)} ${roundSvg(end.y)}`,
    endX: roundSvg(end.x),
    endY: roundSvg(end.y),
    capPoints: rollArrowPoints(endAngle, directionSign, end),
    arcDegrees,
    speedDegreesPerSecond: (magnitude * 180) / Math.PI,
    maxDegreesPerSecond: (maxDisplayRate * 180) / Math.PI,
    stable: magnitude <= autoRotationStabilizerThresholdRadians,
    captureBlend: angularCaptureBlend(magnitude),
  };
}

function angularCaptureBlend(angularSpeed: number): number {
  return clamp(1 - angularSpeed / autoRotationStabilizerThresholdRadians, 0, 1);
}

function angularCaptureStyle(captureBlend: number): CSSProperties {
  const orange = { r: 200, g: 123, b: 60 };
  const cyan = { r: 125, g: 229, b: 216 };
  return {
    "--angular-indicator-rgb": [
      Math.round(orange.r + (cyan.r - orange.r) * captureBlend),
      Math.round(orange.g + (cyan.g - orange.g) * captureBlend),
      Math.round(orange.b + (cyan.b - orange.b) * captureBlend),
    ].join(" "),
  } as CSSProperties;
}

function pointOnCircle(
  centerX: number,
  centerY: number,
  radius: number,
  angleDegrees: number,
): { x: number; y: number } {
  const angle = (angleDegrees * Math.PI) / 180;
  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius,
  };
}

function rollArrowPoints(
  angleDegrees: number,
  directionSign: number,
  tip: { x: number; y: number },
): string {
  const angle = (angleDegrees * Math.PI) / 180;
  const tangent = {
    x: -Math.sin(angle) * directionSign,
    y: Math.cos(angle) * directionSign,
  };
  const radial = {
    x: Math.cos(angle),
    y: Math.sin(angle),
  };
  const base = {
    x: tip.x - tangent.x * 9,
    y: tip.y - tangent.y * 9,
  };
  const wing = 4.6;
  const left = {
    x: base.x + radial.x * wing,
    y: base.y + radial.y * wing,
  };
  const right = {
    x: base.x - radial.x * wing,
    y: base.y - radial.y * wing,
  };
  return `${roundSvg(tip.x)},${roundSvg(tip.y)} ${roundSvg(left.x)},${roundSvg(left.y)} ${roundSvg(right.x)},${roundSvg(right.y)}`;
}

function roundSvg(value: number): number {
  return Math.round(value * 10) / 10;
}

function angularStabilizerRing(flightInputScale: number): {
  radius: number;
  thresholdDegreesPerSecond: number;
} {
  const maxDisplayRate = maxAngularRingDisplayRate(flightInputScale);
  return {
    radius: clamp((autoRotationStabilizerThresholdRadians / maxDisplayRate) * 26, 0, 26),
    thresholdDegreesPerSecond: (autoRotationStabilizerThresholdRadians * 180) / Math.PI,
  };
}

function maxAngularDisplayRate(
  angularVelocity: { x: number; y: number; z: number },
  flightInputScale: number,
): number {
  const magnitude = vectorMagnitude(angularVelocity);
  if (magnitude <= 0.000001) {
    return maxAngularRingDisplayRate(flightInputScale);
  }

  const scale = clamp(flightInputScale, flightInputScaleMin, flightInputScaleMax);
  const unitX = angularVelocity.x / magnitude;
  const unitY = angularVelocity.y / magnitude;
  const unitZ = angularVelocity.z / magnitude;
  const maxX =
    Math.abs(unitX) <= 0.000001 ? Number.POSITIVE_INFINITY : shipMaxAngularRate.x / Math.abs(unitX);
  const maxY =
    Math.abs(unitY) <= 0.000001 ? Number.POSITIVE_INFINITY : shipMaxAngularRate.y / Math.abs(unitY);
  const maxZ =
    Math.abs(unitZ) <= 0.000001 ? Number.POSITIVE_INFINITY : shipMaxAngularRate.z / Math.abs(unitZ);
  return Math.max(autoRotationStabilizerThresholdRadians, Math.min(maxX, maxY, maxZ) * scale);
}

function maxAngularRingDisplayRate(flightInputScale: number): number {
  const scale = clamp(flightInputScale, flightInputScaleMin, flightInputScaleMax);
  return Math.max(
    autoRotationStabilizerThresholdRadians,
    vectorMagnitude(shipMaxAngularRate) * scale,
  );
}

function projectWorldPoint(
  position: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  camera: Camera,
  scratch: ThreeVector3,
): ScreenPoint {
  const scene = toScene(position, origin);
  scratch.set(scene.x, scene.y, scene.z);
  camera.updateMatrixWorld();
  scratch.project(camera);
  const visible =
    Number.isFinite(scratch.x) &&
    Number.isFinite(scratch.y) &&
    Number.isFinite(scratch.z) &&
    scratch.z >= -1 &&
    scratch.z <= 1 &&
    scratch.x >= -1.35 &&
    scratch.x <= 1.35 &&
    scratch.y >= -1.35 &&
    scratch.y <= 1.35;
  return {
    x: Math.max(6, Math.min(94, Math.round((scratch.x * 50 + 50) * 10) / 10)),
    y: Math.max(10, Math.min(88, Math.round((-scratch.y * 50 + 50) * 10) / 10)),
    visible,
  };
}

// Like projectWorldPoint but always returns a usable position by clamping to
// the screen boundary. Sets visible=true when on-screen, visible=false when
// edge-clamped. Behind-camera points are flipped before clamping.
function projectWorldPointClamped(
  position: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  camera: Camera,
  scratch: ThreeVector3,
): ScreenPoint {
  const scene = toScene(position, origin);
  scratch.set(scene.x, scene.y, scene.z);
  camera.updateMatrixWorld();
  scratch.project(camera);
  if (!Number.isFinite(scratch.x) || !Number.isFinite(scratch.y)) {
    return { x: 50, y: 10, visible: false };
  }
  let nx = scratch.x;
  let ny = scratch.y;
  // Behind camera — flip so the clamped indicator still points the right way
  if (scratch.z > 1) {
    nx = -nx;
    ny = -ny;
  }
  const onScreen = scratch.z >= -1 && scratch.z <= 1 && nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
  // Clamp to safe HUD margins
  const x = Math.max(6, Math.min(94, Math.round((nx * 50 + 50) * 10) / 10));
  const y = Math.max(10, Math.min(88, Math.round((-ny * 50 + 50) * 10) / 10));
  return { x, y, visible: onScreen };
}

// A point far along a unit bearing, used when the selected contact has a known
// direction but no resolved world position (e.g. a raw scan hit).
function bearingPoint(
  origin: { x: number; y: number; z: number },
  bearing: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const mag = Math.hypot(bearing.x, bearing.y, bearing.z);
  if (mag < 1e-6) {
    return null;
  }
  const reach = 1_000_000;
  return {
    x: origin.x + (bearing.x / mag) * reach,
    y: origin.y + (bearing.y / mag) * reach,
    z: origin.z + (bearing.z / mag) * reach,
  };
}

// Direction from screen center toward the selected target. Returns the CSS
// rotation (degrees) for a right-pointing arrow plus a 0..1 strength used to
// fade the arrow out as the target nears the center of view (you've found it).
// Targets behind the camera flip the projected direction so the arrow still
// points the short way around.
function projectSelectionArrow(
  target: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  camera: Camera,
  scratch: ThreeVector3,
  view: ThreeVector3,
): SelectionArrow | null {
  const scene = toScene(target, origin);
  scratch.set(scene.x, scene.y, scene.z);
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  view.copy(scratch).applyMatrix4(camera.matrixWorldInverse);
  const behind = view.z >= 0;
  scratch.project(camera);
  let dx = scratch.x;
  let dy = scratch.y;
  if (behind) {
    dx = -dx;
    dy = -dy;
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return null;
  }
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) {
    // Dead-center: in front means you're already facing it (hide the arrow);
    // directly behind means nudge straight down to prompt a turn-around.
    return behind ? { angleDeg: 90, strength: 1 } : null;
  }
  // CSS y-axis points down, so negate dy when converting the NDC direction
  // (y-up) into a screen-space rotation for a right-pointing arrow.
  const angleDeg = (Math.atan2(-dy / len, dx / len) * 180) / Math.PI;
  // Fade out only when the target is nearly centered (within ~5% of screen
  // center in NDC), otherwise always show at full strength.
  const ndcDist = Math.hypot(scratch.x, scratch.y);
  const strength = behind ? 1 : clamp((ndcDist - 0.05) / (0.25 - 0.05), 0, 1);
  if (!behind && strength <= 0.01) {
    return null;
  }
  return { angleDeg, strength };
}

// Single HUD arrow pinned to the screen center, rotated toward the selected
// World-radius in meters for entity kinds that don't have an explicit radius.
const KIND_RADIUS: Record<string, number> = {
  ship: 12,
  structure: 35,
  deposit: 8,
  pocket: 20,
};

// Project a screen-space bounding box for the selected entity by projecting the
// center and a point offset by the entity's radius along the camera's right
// axis. This gives accurate perspective-correct size at any distance.
function projectSelectionBox(
  row: OverviewRow,
  asteroidById: Map<string, Asteroid>,
  origin: { x: number; y: number; z: number },
  camera: Camera,
  scratch: ThreeVector3,
  radiusScratch: ThreeVector3,
): SelectionBox | null {
  if (row.position === null) return null;

  // Entity world radius in meters
  let radius = KIND_RADIUS[row.kind] ?? 12;
  if (row.kind === "asteroid") {
    const asteroid = asteroidById.get(row.id);
    if (asteroid !== undefined) radius = asteroid.radius;
  }

  // Project center
  const center = projectWorldPoint(row.position, origin, camera, scratch);
  if (!center.visible) return null;

  // Project center + radius along camera right axis (in scene units)
  const sceneRadius = radius / 1000; // metersPerSceneUnit = 1000
  camera.updateMatrixWorld();
  // Camera right = first column of camera matrixWorld
  const rx = camera.matrixWorld.elements[0];
  const ry = camera.matrixWorld.elements[1];
  const rz = camera.matrixWorld.elements[2];
  const scene = toScene(row.position, origin);
  radiusScratch.set(
    scene.x + rx * sceneRadius,
    scene.y + ry * sceneRadius,
    scene.z + rz * sceneRadius,
  );
  radiusScratch.project(camera);

  const edgeX = Math.round((radiusScratch.x * 50 + 50) * 10) / 10;
  const sizePct = Math.max(2, Math.abs(edgeX - center.x) * 2);

  return { x: center.x, y: center.y, sizePct, distance: row.distance };
}

function SelectionBoxLayer({ box }: { box: SelectionBox | null }): ReactNode {
  if (box === null) return null;
  return (
    <div className="selection-box-layer" aria-hidden={true}>
      <div
        className="selection-box"
        data-testid="selection-box"
        style={{
          left: `${box.x}%`,
          top: `${box.y}%`,
          width: `${box.sizePct}%`,
          aspectRatio: "1",
        }}
      >
        <span className="selection-box-distance">{formatDistance(box.distance)}</span>
      </div>
    </div>
  );
}

// target. Pointer-events are disabled so it never intercepts clicks.
function SelectionArrowLayer({ arrow }: { arrow: SelectionArrow | null }): ReactNode {
  if (arrow === null) {
    return null;
  }
  return (
    <div className="selection-arrow-layer" aria-hidden={true}>
      <div
        className="selection-arrow"
        data-testid="selection-arrow"
        data-angle-degrees={Math.round(arrow.angleDeg)}
        style={{
          transform: `translate(-50%, -50%) rotate(${arrow.angleDeg}deg) translateX(40px)`,
          opacity: 0.2 + 0.8 * arrow.strength,
        }}
      />
    </div>
  );
}

// First child in the scene: advances the render store once per frame (must run
// before any consumer samples it), drives the first-person camera from the
// smoothed owned orientation, and exposes the rendered origin for measurement.
function RenderDriver({ fallbackShip }: { fallbackShip: Ship }): null {
  const cockpit = useMemo(() => new ThreeVector3(0, 0.12, 0), []);
  const cockpitWorld = useMemo(() => new ThreeVector3(), []);
  const quaternion = useMemo(() => new ThreeQuaternion(), []);
  // Pitch the camera 90° up about its right axis (R_x(+90°)), used only by the
  // benchmark's faceAway control to look straight along world +Y into the void
  // above the lifted camera. See the faceAway block below.
  const lookUp = useMemo(() => new ThreeQuaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2), []);
  const infoArmed = useRef(false);

  useFrame(({ camera, gl }, delta) => {
    // renderer.info auto-resets on every internal render() call, and the
    // post-processing composer issues many per frame — so the default reading is
    // just the last fullscreen quad. Disable auto-reset and drain the previous
    // frame's fully-accumulated totals here, before this frame renders.
    if (!infoArmed.current) {
      gl.info.autoReset = false;
      infoArmed.current = true;
    }
    renderStats.frameTick(delta * 1000, gl.info.render.calls, gl.info.render.triangles);
    gl.info.reset();

    flightRenderStore.advance(delta);
    const orientation = flightRenderStore.hasOwned()
      ? flightRenderStore.ownedRenderQuaternion()
      : fallbackShip.orientation;
    quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w).normalize();
    cockpitWorld.copy(cockpit).applyQuaternion(quaternion);
    camera.position.copy(cockpitWorld);
    camera.quaternion.copy(quaternion);
    if (getRenderDebugControls().faceAway) {
      // Measure real per-chunk frustum culling on an empty view: the ship sits at
      // the field CENTER (spawn origin), so the derived ball surrounds it and a mere
      // 180° yaw still stares into rocks. Instead lift the camera far above the whole
      // field (chunks span at most ±~57 scene units around the rebased origin) and
      // look straight up into empty space — every chunk falls behind the near plane,
      // so a correctly culled field submits ~0 instances.
      camera.position.set(0, EMPTY_VIEW_LIFT, 0);
      camera.quaternion.copy(lookUp);
    }
    camera.updateProjectionMatrix();

    if (typeof window !== "undefined") {
      const origin = renderOrigin(fallbackShip.position);
      (
        window as unknown as {
          __probe?: {
            owned: Vector3;
            ownedQuat: { x: number; y: number; z: number; w: number };
          };
        }
      ).__probe = {
        owned: { x: origin.x, y: origin.y, z: origin.z },
        ownedQuat: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
      };
    }
  });

  return null;
}

// How far (scene units) the benchmark's faceAway control lifts the camera above
// the field before looking up into the void. Must exceed the field half-extent
// (cellsPerAxis * cellSize / 2 = 56.5 km) so every chunk falls behind the camera.
const EMPTY_VIEW_LIFT = 1000;

// The GPU-resident asteroid field (docs/gpu-asteroids-architecture.md §8, §7 step 4). The
// static field is streamed into the CPU-authored `base` buffer (bit-exact with the server
// derive, §3.2 — NOT a GPU frac(sin) kernel); per frame the overlay compute writes
// `pos = base + bounded wobble`, then the cull compute compacts visible slots into per-LOD
// lists + GPU-written indirect instance counts, and FOUR indirect draws (one per LOD
// geometry) render zero-copy through positionNode under the floating origin. No per-chunk
// meshes, no setMatrixAt, no CPU in the cull. The aSunlit two-tier shadow rides packAttr.w
// through the material's receivedShadowNode (the TSL port of the old patchAsteroidShader).
const LOD_GEOMETRY_FACTORIES = [
  () => new DodecahedronGeometry(1, 0), // band 0: full, 36 tris
  () => new IcosahedronGeometry(1, 0), // band 1: 20 tris, near-identical silhouette
  () => new OctahedronGeometry(1, 0), // band 2: 8 tris, fogged sub-dozen-px rocks
  () => new TetrahedronGeometry(1, 0), // band 3: 4 tris, far heavily-fogged <5px specks
] as const;

function InstancedAsteroids({
  asteroids,
  fallbackOrigin,
}: {
  asteroids: Asteroid[];
  fallbackOrigin: Vector3;
}): ReactNode {
  // The R3F renderer is the WebGPURenderer the gl factory produced; we only need compute().
  const gl = useThree((state) => state.gl) as unknown as {
    compute(node: typeof genFieldOverlay): void;
  };
  const lod = useMemo(() => {
    const geometries = LOD_GEOMETRY_FACTORIES.map((make) => make());
    const pipeline = makeCullPipeline(
      geometries.map((geometry) => geometry.attributes["position"]!.count),
    );
    geometries.forEach((geometry, band) => geometry.setIndirect(pipeline.indirectAttrs[band]!));
    const materials = pipeline.lodLists.map((list) => makeLodAsteroidMaterial(list));
    return { geometries, pipeline, materials };
  }, []);
  useEffect(
    () => () => {
      for (const geometry of lod.geometries) geometry.dispose();
      for (const material of lod.materials) material.dispose();
    },
    [lod],
  );
  const projScreen = useMemo(() => new Matrix4(), []);
  // Step 7: the collision pipeline + the deterministic wells that manufacture its density.
  const collision = useMemo(() => makeCollisionPipeline(), []);
  const wells = useMemo(() => deriveGravityWells(), []);

  // Ring-stream base/packAttr/slotMeta from the app's already-derived field (the worker +
  // reconcile output) on each visible-set change — a CPU derive + buffer SUB-RANGE write,
  // never a GPU kernel (§3.2, §7 step 4). The ring reconciles incrementally: kept rocks'
  // slots (and bytes) are untouched, entering rocks fill freed slots, evicted slots go
  // zero-radius; only the dirty ranges are uploaded. Per-slot bytes are identical to the
  // full packBaseFromAsteroids pack (gpu-ring-stream.test.ts pins this against the parity
  // gate's pack). useLayoutEffect so upload + draw-count land before the new set's paint.
  const ringRef = useRef<FieldRingStream | null>(null);
  useLayoutEffect(() => {
    const start = performance.now();
    const ring = (ringRef.current ??= new FieldRingStream(MAX_RESIDENT));
    const result = ring.reconcile(asteroids, {
      base: backingArrayOf(base),
      packAttr: backingArrayOf(packAttr),
      slotMeta: backingU32Of(slotMeta),
    });
    // Merge near-adjacent dirty slots (uploading a small gap beats another writeBuffer
    // call) and cap the per-frame range count; beyond the cap one spanning write wins.
    const ranges = mergeDirtyToRanges(result.dirty, 64, 64);
    markRangesForUpload(base, ranges);
    markRangesForUpload(packAttr, ranges);
    markRangesForUpload(slotMeta, ranges);
    // A recycled slot must not inherit the previous occupant's collision state: the CPU
    // backings of collOffset/collVel stay all-zero, so re-uploading the dirty ranges
    // resets exactly those slots on the GPU.
    markRangesForUpload(collOffset, ranges);
    markRangesForUpload(collVel, ranges);
    renderStats.noteFieldWork(performance.now() - start);
  }, [asteroids]);

  // Per frame: recentre the floating origin, advance the cosmetic ticker, refresh the
  // frustum planes, and submit overlay + cull compute in ONE submission (§3.3 — never
  // computeAsync-awaited in the hot loop). The camera transform was just written by
  // RenderDriver (mounted first, same priority -> runs first); updateMatrixWorld also
  // refreshes matrixWorldInverse, so the planes are THIS frame's.
  useFrame(({ camera }, delta) => {
    const origin = renderOrigin(fallbackOrigin);
    originMeters.value.set(origin.x, origin.y, origin.z);
    frameCounter.value += 1;
    camera.updateMatrixWorld();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    lod.pipeline.updatePlanes(projScreen);
    gl.compute(genFieldOverlay);
    // Collisions (§3.4 Nc==0 gate): only worth binning when a gravity well's clump can
    // reach the near-window — the native field never overlaps. Skips the ENTIRE broad +
    // narrow graph (and its fixed clear/scan floor) when no well is in range.
    const half = COLLISION_WINDOW_METERS / 2;
    const reach = half + WELL_SIGMA_METERS * 3;
    const collisionActive = wells.some((well) => {
      const dx = well.x - origin.x;
      const dy = well.y - origin.y;
      const dz = well.z - origin.z;
      return dx * dx + dy * dy + dz * dz < reach * reach;
    });
    if (collisionActive) {
      const snapped = snapGridOrigin(origin);
      gridOrigin.value.set(snapped.x, snapped.y, snapped.z);
      collisionDt.value = Math.min(delta, 1 / 30); // fixed-ish dt, refocus-clamped (§4.4)
      for (const kernel of collision.dispatches) {
        gl.compute(kernel);
      }
    }
    gl.compute(lod.pipeline.clearCull);
    gl.compute(lod.pipeline.cull);
    gl.compute(lod.pipeline.publishCounts);
  });

  if (asteroids.length === 0) {
    return null;
  }

  // One indirect draw per LOD band. The CPU-side instance count is the slot capacity; the
  // REAL count is the GPU-written indirect instanceCount (so frustumCulled stays off and
  // three's CPU-side info counts are nominal, not actual).
  return (
    <>
      {lod.geometries.map((geometry, band) => (
        <instancedMesh
          key={band}
          args={[geometry, lod.materials[band]!, MAX_RESIDENT]}
          frustumCulled={false}
          castShadow
          receiveShadow
        />
      ))}
    </>
  );
}
function StructureMesh({
  structure,
  fallbackOrigin,
}: {
  structure: Structure;
  fallbackOrigin: Vector3;
}): ReactNode {
  const groupRef = useRef<Object3D>(null);
  const scale: [number, number, number] =
    structure.kind === "station" ? [0.26, 0.08, 0.26] : [0.11, 0.17, 0.11];

  useFrame(() => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }
    const position = toScene(structure.position, renderOrigin(fallbackOrigin));
    group.position.set(position.x, position.y, position.z);
  });

  return (
    <group ref={groupRef}>
      <mesh scale={scale} receiveShadow>
        <boxGeometry />
        <meshStandardMaterial color={structure.hidden ? "#5b725e" : "#b58b55"} roughness={0.74} />
      </mesh>
      <mesh position={[0, 0.14, 0]} scale={[0.07, 0.07, 0.07]}>
        <octahedronGeometry />
        <meshStandardMaterial color="#87d0bd" emissive="#0f3f35" emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

function ConditionalListenerRig({
  ctx,
  volume,
  children,
}: {
  ctx: AudioContext | null;
  volume: number;
  children: ReactNode;
}): ReactNode {
  if (ctx === null) {
    return <>{children}</>;
  }
  return (
    <AudioListenerRig ctx={ctx} volume={volume}>
      {children}
    </AudioListenerRig>
  );
}

function OtherShipMesh({
  ship,
  fallbackOrigin,
  audioContext,
}: {
  ship: Ship;
  fallbackOrigin: Vector3;
  audioContext: AudioContext | null;
}): ReactNode {
  const groupRef = useRef<Object3D>(null);
  const audioState = useMemo(
    () => ({
      throttle: ship.throttle,
      heat: ship.heat,
      speed: vectorMagnitude(ship.velocity),
    }),
    [ship.heat, ship.throttle, ship.velocity.x, ship.velocity.y, ship.velocity.z],
  );

  useEffect(() => {
    const pilotId = ship.pilotId;
    return () => flightRenderStore.removeRemote(pilotId);
  }, [ship.pilotId]);

  useFrame(() => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }
    // Position/orientation come from the interpolation buffer (smooth between
    // authoritative snapshots on the server-time clock); fall back to the latest
    // snapshot value until the buffer has data.
    const sample = flightRenderStore.sampleRemote(ship.pilotId);
    const worldPosition = sample !== null ? sample.position : ship.position;
    const orientation = sample !== null ? sample.orientation : ship.orientation;
    const position = toScene(worldPosition, renderOrigin(fallbackOrigin));
    group.position.set(position.x, position.y, position.z);
    group.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w).normalize();
  });

  return (
    <group ref={groupRef}>
      <mesh scale={[0.08, 0.08, 0.08]} receiveShadow>
        <coneGeometry args={[0.6, 1.4, 4]} />
        <meshStandardMaterial color="#b54f57" roughness={0.7} />
      </mesh>
      {audioContext !== null ? <RemoteShipAudio ctx={audioContext} state={audioState} /> : null}
    </group>
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
          <meshBasicMaterial color={index % 5 === 0 ? "#d6b36f" : "#c8d2c5"} fog={false} />
        </mesh>
      ))}
    </group>
  );
}
