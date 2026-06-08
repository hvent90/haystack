import { Canvas, useFrame } from "@react-three/fiber";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Object3D,
  Quaternion as ThreeQuaternion,
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
import { clamp, formatDistance, toScene, vectorMagnitude } from "../vector";
import { sameSelection } from "../overview";
import { flightRenderStore } from "../renderStore";
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
        camera={{ position: [0, 0.12, 0], fov: 68, near: 0.01, far: 2000 }}
        dpr={[1, 1.5]}
      >
        <RenderDriver fallbackShip={myShip} />
        <SceneProjection
          rows={bracketRows}
          myShip={myShip}
          waypoint={waypoint}
          onProject={setScreenPoints}
        />
        <color attach="background" args={["#03040a"]} />
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
  onProject,
}: {
  rows: OverviewRow[];
  myShip: Ship;
  waypoint: Waypoint | null;
  onProject: (points: Record<string, ScreenPoint>) => void;
}): null {
  const projected = useMemo(() => new ThreeVector3(), []);
  const lastSignature = useRef("");

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
    if (speed > 0.35) {
      const projectionDistance = Math.max(1800, Math.min(14000, speed * 42));
      const velocityDirection = {
        x: myShip.velocity.x / speed,
        y: myShip.velocity.y / speed,
        z: myShip.velocity.z / speed,
      };
      next["velocity"] = projectWorldPoint(
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
      {velocityPoint?.visible === true ? (
        <div
          className="velocity-vector"
          data-testid="velocity-vector"
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

// First child in the scene: advances the render store once per frame (must run
// before any consumer samples it), drives the first-person camera from the
// smoothed owned orientation, and exposes the rendered origin for measurement.
function RenderDriver({ fallbackShip }: { fallbackShip: Ship }): null {
  const cockpit = useMemo(() => new ThreeVector3(0, 0.12, 0), []);
  const cockpitWorld = useMemo(() => new ThreeVector3(), []);
  const quaternion = useMemo(() => new ThreeQuaternion(), []);

  useFrame(({ camera }, delta) => {
    flightRenderStore.advance(delta);
    const orientation = flightRenderStore.hasOwned()
      ? flightRenderStore.ownedRenderQuaternion()
      : fallbackShip.orientation;
    quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w).normalize();
    cockpitWorld.copy(cockpit).applyQuaternion(quaternion);
    camera.position.copy(cockpitWorld);
    camera.quaternion.copy(quaternion);
    camera.updateProjectionMatrix();

    if (typeof window !== "undefined") {
      const origin = renderOrigin(fallbackShip.position);
      (window as unknown as { __probe?: { owned: Vector3 } }).__probe = {
        owned: { x: origin.x, y: origin.y, z: origin.z },
      };
    }
  });

  return null;
}

function InstancedAsteroids({
  asteroids,
  fallbackOrigin,
}: {
  asteroids: Asteroid[];
  fallbackOrigin: Vector3;
}): ReactNode {
  const meshRef = useRef<InstancedMesh>(null);
  const transform = useMemo(() => new Object3D(), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }
    const origin = renderOrigin(fallbackOrigin);
    asteroids.forEach((asteroid, index) => {
      const position = toScene(asteroid.position, origin);
      const size = Math.max(0.04, asteroid.radius / 1000);
      transform.position.set(position.x, position.y, position.z);
      transform.rotation.set(index * 0.43, index * 0.27, 0);
      transform.scale.set(size, size, size);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

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
      <mesh scale={scale}>
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
      <mesh scale={[0.08, 0.08, 0.08]}>
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
          <meshBasicMaterial color={index % 5 === 0 ? "#d6b36f" : "#c8d2c5"} />
        </mesh>
      ))}
    </group>
  );
}
