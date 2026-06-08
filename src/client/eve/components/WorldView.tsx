import { Canvas, useFrame } from "@react-three/fiber";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DodecahedronGeometry,
  InstancedBufferAttribute,
  MeshStandardMaterial,
  Object3D,
  Quaternion as ThreeQuaternion,
  ShaderChunk,
  Vector3 as ThreeVector3,
  type Camera,
  type InstancedMesh,
} from "three";
import type { Asteroid, Ship, Structure, Vector3 } from "../../../shared/types";
import {
  autoRotationStabilizerThresholdRadians,
  shipMaxAngularRate,
} from "../../../shared/ship-motion";
import type { FlightMode, OverviewRow, Selection, Waypoint } from "../types";
import { flightInputScaleMax, flightInputScaleMin } from "../constants";
import { clamp, formatDistance, metersPerSceneUnit, toScene, vectorMagnitude } from "../vector";
import { sameSelection } from "../overview";
import { flightRenderStore } from "../renderStore";
import { fogColor, fogFar, fogNear, shadowBubbleFadeFar, shadowBubbleFadeNear } from "../lighting";
import { sunlitForId } from "../sun-occlusion";
import { getRenderDebugControls, renderStats } from "../render-stats";
import { AudioListenerRig, RemoteShipAudio } from "./SpatialAudio";
import { ShipFlashlight, SunDisc, SunLight } from "./SceneLighting";
import { ScenePostProcessing } from "./ScenePostProcessing";

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
  rows,
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
  rows: OverviewRow[];
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
  const bracketRows = useMemo(
    () => rows.filter((row) => row.position !== null).slice(0, 32),
    [rows],
  );
  const [screenPoints, setScreenPoints] = useState<Record<string, ScreenPoint>>({});
  const [selectionArrow, setSelectionArrow] = useState<SelectionArrow | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const selectedRow = useMemo(
    () => (selected === null ? null : (rows.find((row) => sameSelection(row, selected)) ?? null)),
    [rows, selected],
  );
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
  // id -> asteroid lookup so the per-frame selection-box projection is O(1) instead
  // of a linear scan over the whole visible field each frame.
  const asteroidById = useMemo(() => {
    const map = new Map<string, Asteroid>();
    for (const asteroid of asteroids) {
      map.set(asteroid.id, asteroid);
    }
    return map;
  }, [asteroids]);
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

// Spatial chunk edge length (meters). The derived field is partitioned into cubic
// chunks, each rendered as its own InstancedMesh with its own bounding sphere, so
// three frustum-culls them INDIVIDUALLY — only chunks intersecting the view are
// submitted to the GPU (vs. the old single mesh + single bounding sphere, which was
// all-or-nothing). ~7.5 km balances cull tightness (facing the field submits far
// fewer than the derived count) against a small, bounded visible-chunk count (draw
// calls stay a constant independent of the derived total). Tuned via client-render.
const CHUNK_METERS = 7500;

// Per-chunk draw distance (scene units ~= km). A chunk whose nearest point is beyond
// this from the camera is hidden (mesh.visible=false), so even within the frustum the
// far shell of the derived ball is not submitted: this is the "distance" half of the
// frustum+distance cull. Paired with the fog far plane (lighting.ts) so culled rocks
// are already fogged out — no pop. Also drives camera-facing-empty to ~0 (the lifted
// faceAway camera sits far beyond every chunk). The default-play field (renderedLimit
// 2000) is a ~9 km ball, well inside this, so normal play is unaffected.
const MAX_DRAW_SCENE = 18;

// Half the space-diagonal of a chunk cube (scene units): a chunk's farthest corner
// from its center, used to test the chunk's NEAREST point against the draw distance.
const CHUNK_RADIUS_SCENE = ((CHUNK_METERS / metersPerSceneUnit) * Math.sqrt(3)) / 2;

// Reused scratch for the per-chunk distance test (single-threaded render loop).
const chunkWorldCenter = new ThreeVector3();

type AsteroidChunkData = {
  key: string;
  cx: number;
  cy: number;
  cz: number;
  asteroids: Asteroid[];
};

// Bucket the derived rocks into cubic spatial chunks, preserving per-chunk order.
// Each bucket becomes one frustum- and distance-cullable InstancedMesh. O(N) over the
// derived set. The integer chunk coords give each chunk a cheap, exact cube center for
// the distance test without scanning its rocks.
function partitionIntoChunks(asteroids: Asteroid[]): AsteroidChunkData[] {
  const byKey = new Map<string, AsteroidChunkData>();
  for (const asteroid of asteroids) {
    const cx = Math.floor(asteroid.position.x / CHUNK_METERS);
    const cy = Math.floor(asteroid.position.y / CHUNK_METERS);
    const cz = Math.floor(asteroid.position.z / CHUNK_METERS);
    const key = `${cx}|${cy}|${cz}`;
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = { key, cx, cy, cz, asteroids: [] };
      byKey.set(key, bucket);
    }
    bucket.asteroids.push(asteroid);
  }
  return Array.from(byKey.values());
}

function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

// Patch the asteroid material so the sun's contribution is the two-tier shadow blend:
//   directLight.color *= mix(aSunlit, shadowMapFactor, bubbleWeight)
// Near the camera (bubbleWeight -> 1) the real per-pixel shadow map wins; far away
// (bubbleWeight -> 0) the per-instance occlusion scalar wins. Each replace is anchored to
// the exact three r177 chunk text and throws if it is ever missing, so a future three bump
// fails loudly instead of silently dropping the shadows.
function patchAsteroidShader(shader: { vertexShader: string; fragmentShader: string }): void {
  const fadeNear = glslFloat(shadowBubbleFadeNear);
  const fadeFar = glslFloat(shadowBubbleFadeFar);
  const apply = (source: string, anchor: string, replacement: string): string => {
    if (!source.includes(anchor)) {
      throw new Error(`asteroid shadow patch: missing shader anchor "${anchor.slice(0, 48)}"`);
    }
    return source.replace(anchor, replacement);
  };

  shader.vertexShader = apply(
    shader.vertexShader,
    "#include <common>",
    "#include <common>\nattribute float aSunlit;\nvarying float vSunlit;\nvarying float vBubbleWeight;",
  );
  shader.vertexShader = apply(
    shader.vertexShader,
    "vViewPosition = - mvPosition.xyz;",
    `vViewPosition = - mvPosition.xyz;\n\tvSunlit = aSunlit;\n\tvBubbleWeight = 1.0 - smoothstep( ${fadeNear}, ${fadeFar}, - mvPosition.z );`,
  );
  shader.fragmentShader = apply(
    shader.fragmentShader,
    "#include <common>",
    "#include <common>\nvarying float vSunlit;\nvarying float vBubbleWeight;",
  );

  // The directional shadow term lives INSIDE the lights_fragment_begin chunk, which is still
  // an unresolved `#include` at onBeforeCompile time. Expand that chunk ourselves, blend the
  // sun's shadow factor with the per-instance occlusion, and substitute it for the directive.
  const blendedLights = apply(
    ShaderChunk.lights_fragment_begin,
    "directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;",
    "float dirShadowFactor = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\tdirectLight.color *= mix( vSunlit, dirShadowFactor, vBubbleWeight );",
  );
  shader.fragmentShader = apply(
    shader.fragmentShader,
    "#include <lights_fragment_begin>",
    blendedLights,
  );
}

function createAsteroidMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: "#6f6a60", roughness: 0.96 });
  material.onBeforeCompile = (shader) => patchAsteroidShader(shader);
  return material;
}

// The asteroid field is a static, deterministic set of rocks that never move in
// world space — only the floating origin (the owned ship) moves. So we bake each
// rock's ABSOLUTE field position into its instance matrix ONCE, when the visible
// set changes, and apply the per-frame origin rebase to the wrapping group instead
// of recomputing every matrix. group world position = -origin/1000 = toScene(0,
// origin), so a baked instance at position/1000 lands exactly where
// toScene(position, origin) would have put it. This turns O(N) matrix rebuilds +
// a full instance-buffer GPU re-upload every frame into a single group.position
// write per frame, which is what frees the main thread to drain the 30Hz world
// stream (a saturated render loop was starving the un-gated WebSocket onmessage).
// Baked positions stay within ±~57 scene units (the field half-extent), so the
// float32 instance matrices keep sub-pixel (~mm at the far edge) precision.
function InstancedAsteroids({
  asteroids,
  fallbackOrigin,
}: {
  asteroids: Asteroid[];
  fallbackOrigin: Vector3;
}): ReactNode {
  const groupRef = useRef<Object3D>(null);
  // ONE shared material across every chunk: the shadow patch compiles once and the
  // onAfterRender submitted-count gate keys on this exact material identity, so it
  // sums correctly across all visible chunk meshes. dispose={null} on the chunks
  // keeps three/r3f from disposing this shared material when a chunk unmounts.
  const material = useMemo(() => createAsteroidMaterial(), []);
  useEffect(() => () => material.dispose(), [material]);
  // Per-rock deterministic rotation seed, derived once per id (shared across chunks).
  const seedCache = useRef(new Map<string, number>());

  // Partition the derived field into cubic spatial chunks (once per visible-set
  // change). Each chunk renders as its own bounding-sphere'd InstancedMesh so three
  // frustum-culls them individually — the core of real per-instance culling.
  const chunks = useMemo(() => partitionIntoChunks(asteroids), [asteroids]);

  // Floating-origin rebase: shift the whole field once per frame (O(1)). Each chunk
  // bakes ABSOLUTE field positions into its instance matrices; this group translation
  // carries them all to camera-relative space, and three transforms every chunk's
  // bounding sphere by it before the per-chunk frustum test.
  useFrame(() => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }
    const origin = renderOrigin(fallbackOrigin);
    group.position.set(
      -origin.x / metersPerSceneUnit,
      -origin.y / metersPerSceneUnit,
      -origin.z / metersPerSceneUnit,
    );
  });

  if (asteroids.length === 0) {
    return null;
  }

  return (
    <group ref={groupRef}>
      {chunks.map((chunk) => (
        <AsteroidChunk
          key={chunk.key}
          chunk={chunk}
          material={material}
          seedCache={seedCache.current}
        />
      ))}
    </group>
  );
}

// One spatial chunk of the field: a self-contained InstancedMesh with its own
// geometry (so it can carry a per-instance aSunlit occlusion attribute) and its own
// bounding sphere (so three frustum-culls it independently of the other chunks).
// Instance matrices bake the rocks' ABSOLUTE field positions; the parent group does
// the per-frame origin rebase. The shared material is reused (not owned), so the mesh
// uses dispose={null} and this component disposes only its own geometry on unmount.
function AsteroidChunk({
  chunk,
  material,
  seedCache,
}: {
  chunk: AsteroidChunkData;
  material: MeshStandardMaterial;
  seedCache: Map<string, number>;
}): ReactNode {
  const { asteroids } = chunk;
  const meshRef = useRef<InstancedMesh>(null);
  const transform = useMemo(() => new Object3D(), []);
  const geometry = useMemo(() => new DodecahedronGeometry(1, 0), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // This chunk's cube center in baked (absolute / 1000) scene coordinates. The parent
  // group then translates by -origin/1000 each frame, so adding the group position
  // gives the chunk's camera-relative world center for the distance test below.
  const center = useMemo(
    () => ({
      x: ((chunk.cx + 0.5) * CHUNK_METERS) / metersPerSceneUnit,
      y: ((chunk.cy + 0.5) * CHUNK_METERS) / metersPerSceneUnit,
      z: ((chunk.cz + 0.5) * CHUNK_METERS) / metersPerSceneUnit,
    }),
    [chunk.cx, chunk.cy, chunk.cz],
  );

  // Distance cull (once per frame): hide the chunk when its nearest point is past the
  // draw distance. three still frustum-culls the visible ones, so what survives is the
  // intersection of in-frustum AND near — the frustum+distance "what's actually in
  // view" set. Hidden chunks fire no onAfterRender, so they drop out of the submitted
  // count. Using the chunk's NEAREST corner (center distance minus the cube radius)
  // means no near rock is ever wrongly culled at a chunk boundary.
  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    const group = mesh?.parent;
    if (mesh === null || group === undefined || group === null) {
      return;
    }
    chunkWorldCenter.set(
      center.x + group.position.x,
      center.y + group.position.y,
      center.z + group.position.z,
    );
    const nearest = chunkWorldCenter.distanceTo(camera.position) - CHUNK_RADIUS_SCENE;
    mesh.visible = nearest < MAX_DRAW_SCENE;
  });

  // Build the instance matrices + per-instance occlusion once per chunk-set change
  // (NOT per frame), then compute this chunk's tight bounding sphere for culling.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }
    const count = asteroids.length;
    const sunlit = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const asteroid = asteroids[index];
      if (asteroid === undefined) {
        continue;
      }
      const size = Math.max(0.04, asteroid.radius / metersPerSceneUnit);
      let seed = seedCache.get(asteroid.id);
      if (seed === undefined) {
        seed = asteroid.id
          .split("-")
          .slice(1)
          .reduce((a, b) => a + Number(b) * 7919, 0);
        seedCache.set(asteroid.id, seed);
      }
      transform.position.set(
        asteroid.position.x / metersPerSceneUnit,
        asteroid.position.y / metersPerSceneUnit,
        asteroid.position.z / metersPerSceneUnit,
      );
      transform.rotation.set(seed * 0.43, seed * 0.27, seed * 0.17);
      transform.scale.set(size, size, size);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      sunlit[index] = sunlitForId(asteroid.id);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    const existing = mesh.geometry.getAttribute("aSunlit") as InstancedBufferAttribute | undefined;
    if (existing === undefined || existing.array.length !== count) {
      mesh.geometry.setAttribute("aSunlit", new InstancedBufferAttribute(sunlit, 1));
    } else {
      (existing.array as Float32Array).set(sunlit);
      existing.needsUpdate = true;
    }
    mesh.computeBoundingSphere();
  }, [asteroids, transform, geometry, seedCache]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, asteroids.length]}
      castShadow
      receiveShadow
      dispose={null}
      onAfterRender={(_renderer, _scene, _camera, geom, renderedMaterial) => {
        // three only invokes onAfterRender for objects that survive frustum culling,
        // and the asteroid material is used solely in the main color pass (shadow ->
        // depth material, NormalPass -> normal material), so this counts each in-view
        // instance exactly once per frame, summed across all visible chunks.
        if (renderedMaterial !== material) {
          return;
        }
        const mesh = meshRef.current;
        if (mesh === null) {
          return;
        }
        const index = geom.index;
        const trianglesPerInstance =
          index === null ? (geom.attributes.position?.count ?? 0) / 3 : index.count / 3;
        renderStats.noteSubmitted(mesh.count, trianglesPerInstance);
      }}
    />
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
