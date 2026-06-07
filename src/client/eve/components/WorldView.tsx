import { Canvas, useFrame } from "@react-three/fiber";
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
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
import { formatDistance, toScene, vectorMagnitude } from "../vector";
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
      <FlightVectorLayer
        velocityPoint={screenPoints["velocity"]}
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
      next["velocity"] = projectWorldPoint(
        {
          x: myShip.position.x + (myShip.velocity.x / speed) * projectionDistance,
          y: myShip.position.y + (myShip.velocity.y / speed) * projectionDistance,
          z: myShip.position.z + (myShip.velocity.z / speed) * projectionDistance,
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
  flightMode,
  mouseDeflection,
}: {
  velocityPoint: ScreenPoint | undefined;
  flightMode: FlightMode;
  mouseDeflection: { x: number; y: number; z: number };
}): ReactNode {
  const yaw = mouseDeflection.y;
  const pitch = mouseDeflection.x;
  const aimX = 50 - yaw * 24;
  const aimY = 50 - pitch * 24;
  const dx = aimX - 50;
  const dy = aimY - 50;
  const aimLength = Math.min(28, Math.sqrt(dx * dx + dy * dy));
  const aimAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const showAim = flightMode === "flight" && aimLength > 1.2;

  return (
    <div className="flight-vector-layer" aria-hidden="true">
      {velocityPoint?.visible === true ? (
        <div
          className="velocity-vector"
          data-testid="velocity-vector"
          style={{ left: `${velocityPoint.x}%`, top: `${velocityPoint.y}%` }}
        />
      ) : null}
      {showAim ? (
        <>
          <div
            className="aim-delta-line"
            data-testid="aim-delta-line"
            style={{
              width: `${aimLength}%`,
              transform: `rotate(${aimAngle}deg)`,
            }}
          />
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
  const position = toScene(ship.position, origin);
  const audioState = useMemo(
    () => ({
      throttle: ship.throttle,
      heat: ship.heat,
      speed: vectorMagnitude(ship.velocity),
    }),
    [ship.heat, ship.throttle, ship.velocity.x, ship.velocity.y, ship.velocity.z],
  );
  return (
    <group position={[position.x, position.y, position.z]}>
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
