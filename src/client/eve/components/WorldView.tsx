import { Canvas, useFrame } from "@react-three/fiber";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Object3D,
  Quaternion as ThreeQuaternion,
  Vector3 as ThreeVector3,
  type Camera,
  type InstancedMesh,
} from "three";
import type { Asteroid, Quaternion, Ship, Structure } from "../../../shared/types";
import type { FlightMode, OverviewRow, Selection, Waypoint } from "../types";
import { flightInputScaleMax, flightInputScaleMin } from "../constants";
import { clamp, formatDistance, toScene, vectorMagnitude } from "../vector";
import { sameSelection } from "../overview";
import { AudioListenerRig, RemoteShipAudio } from "./SpatialAudio";

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
        <ShipFirstPersonCamera orientation={myShip.orientation} />
        <SceneProjection
          rows={bracketRows}
          myShip={myShip}
          waypoint={waypoint}
          onProject={setScreenPoints}
        />
        <color attach="background" args={["#10100f"]} />
        <ambientLight intensity={0.62} />
        <pointLight position={[8, 12, 10]} intensity={1.4} color="#f5c16f" />
        <ConditionalListenerRig ctx={audioContext} volume={audioVolume}>
          <group>
            <GridStars />
            <InstancedAsteroids asteroids={asteroids} origin={myShip.position} />
            {structures.map((structure) => (
              <StructureMesh key={structure.id} structure={structure} origin={myShip.position} />
            ))}
            {ships
              .filter((ship) => ship.pilotId !== myShip.pilotId)
              .map((ship) => (
                <OtherShipMesh
                  key={ship.pilotId}
                  ship={ship}
                  origin={myShip.position}
                  audioContext={audioContext}
                />
              ))}
          </group>
        </ConditionalListenerRig>
      </Canvas>
      <div className="reticle" data-testid="hud-reticle" />
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
    const next: Record<string, ScreenPoint> = {};
    for (const row of rows) {
      if (row.position === null) {
        continue;
      }
      next[row.key] = projectWorldPoint(row.position, myShip.position, camera, projected);
    }
    if (waypoint !== null) {
      next["waypoint"] = projectWorldPoint(waypoint.position, myShip.position, camera, projected);
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
          x: myShip.position.x + velocityDirection.x * projectionDistance,
          y: myShip.position.y + velocityDirection.y * projectionDistance,
          z: myShip.position.z + velocityDirection.z * projectionDistance,
        },
        myShip.position,
        camera,
        projected,
      );
      next["reverseVelocity"] = projectWorldPoint(
        {
          x: myShip.position.x - velocityDirection.x * projectionDistance,
          y: myShip.position.y - velocityDirection.y * projectionDistance,
          z: myShip.position.z - velocityDirection.z * projectionDistance,
        },
        myShip.position,
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

  return (
    <div className="flight-vector-layer" aria-hidden="true">
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
            data-roll-dir={torque.rollDirection}
            data-capped={torque.capped}
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
  rollDirection: string;
  capped: boolean;
  capStartX: number;
  capStartY: number;
  capEndX: number;
  capEndY: number;
  labelX: number;
  labelY: number;
  labelAngle: number;
  degreesPerSecond: string;
} | null {
  const screenX = angularVelocity.y;
  const screenY = angularVelocity.x;
  const planarMagnitude = Math.sqrt(screenX * screenX + screenY * screenY);
  const rollMagnitude = Math.abs(angularVelocity.z);
  const scaledFloor = 0.018 * clamp(flightInputScale, flightInputScaleMin, flightInputScaleMax);
  if (planarMagnitude <= scaledFloor && rollMagnitude <= scaledFloor) {
    return null;
  }

  const fallbackRollDirection = angularVelocity.z >= 0 ? -1 : 1;
  const directionX =
    planarMagnitude > scaledFloor ? screenX / planarMagnitude : fallbackRollDirection;
  const directionY = planarMagnitude > scaledFloor ? screenY / planarMagnitude : 0;
  const magnitude = Math.max(planarMagnitude, rollMagnitude);
  const rawLength =
    (magnitude * 18) / clamp(flightInputScale, flightInputScaleMin, flightInputScaleMax);
  const capped = rawLength >= 26;
  const length = Math.min(26, rawLength);
  const capSize = 2.4;
  const capX = -directionY * capSize;
  const capY = directionX * capSize;
  const lineAngle = (Math.atan2(directionY, directionX) * 180) / Math.PI;
  const labelAngle = lineAngle > 90 || lineAngle < -90 ? lineAngle + 180 : lineAngle;

  return {
    x: Math.round((50 + directionX * length) * 10) / 10,
    y: Math.round((50 + directionY * length) * 10) / 10,
    rollDirection:
      angularVelocity.z > scaledFloor
        ? "positive"
        : angularVelocity.z < -scaledFloor
          ? "negative"
          : "none",
    capped,
    capStartX: Math.round((50 + directionX * length - capX) * 10) / 10,
    capStartY: Math.round((50 + directionY * length - capY) * 10) / 10,
    capEndX: Math.round((50 + directionX * length + capX) * 10) / 10,
    capEndY: Math.round((50 + directionY * length + capY) * 10) / 10,
    labelX: Math.round((50 + directionX * Math.max(10, length * 0.58)) * 10) / 10,
    labelY: Math.round((50 + directionY * Math.max(10, length * 0.58)) * 10) / 10,
    labelAngle: Math.round(labelAngle * 10) / 10,
    degreesPerSecond: `${Math.round((magnitude * 180) / Math.PI)} deg/s`,
  };
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

function ShipFirstPersonCamera({ orientation }: { orientation: Quaternion }): null {
  const cockpit = useMemo(() => new ThreeVector3(0, 0.12, 0), []);
  const cockpitWorld = useMemo(() => new ThreeVector3(), []);
  const quaternion = useMemo(() => new ThreeQuaternion(), []);

  useFrame(({ camera }) => {
    quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w).normalize();
    cockpitWorld.copy(cockpit).applyQuaternion(quaternion);
    camera.position.copy(cockpitWorld);
    camera.quaternion.copy(quaternion);
    camera.updateProjectionMatrix();
  });

  return null;
}

function InstancedAsteroids({
  asteroids,
  origin,
}: {
  asteroids: Asteroid[];
  origin: { x: number; y: number; z: number };
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
      const size = Math.max(0.04, asteroid.radius / 1000);
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
  origin: { x: number; y: number; z: number };
}): ReactNode {
  const position = toScene(structure.position, origin);
  const scale: [number, number, number] =
    structure.kind === "station" ? [0.26, 0.08, 0.26] : [0.11, 0.17, 0.11];
  return (
    <group position={[position.x, position.y, position.z]}>
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
  origin,
  audioContext,
}: {
  ship: Ship;
  origin: { x: number; y: number; z: number };
  audioContext: AudioContext | null;
}): ReactNode {
  const groupRef = useRef<Object3D>(null);
  const targetPosition = useMemo(() => new ThreeVector3(), []);
  const targetQuaternion = useMemo(() => new ThreeQuaternion(), []);
  const initialized = useRef(false);
  const audioState = useMemo(
    () => ({
      throttle: ship.throttle,
      heat: ship.heat,
      speed: vectorMagnitude(ship.velocity),
    }),
    [ship.heat, ship.throttle, ship.velocity.x, ship.velocity.y, ship.velocity.z],
  );

  useFrame((_state, delta) => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }

    const position = toScene(ship.position, origin);
    targetPosition.set(position.x, position.y, position.z);
    targetQuaternion
      .set(ship.orientation.x, ship.orientation.y, ship.orientation.z, ship.orientation.w)
      .normalize();

    if (!initialized.current) {
      group.position.copy(targetPosition);
      group.quaternion.copy(targetQuaternion);
      initialized.current = true;
      return;
    }

    const alpha = Math.min(1, delta * 8);
    group.position.lerp(targetPosition, alpha);
    group.quaternion.slerp(targetQuaternion, alpha);
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
