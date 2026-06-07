import type { Vector3 } from "../../shared/types";

export const metersPerSceneUnit = 1000;

export function toScene(position: Vector3, origin: Vector3): Vector3 {
  return {
    x: (position.x - origin.x) / metersPerSceneUnit,
    y: (position.y - origin.y) / metersPerSceneUnit,
    z: (position.z - origin.z) / metersPerSceneUnit,
  };
}

export function vectorMagnitude(vector: Vector3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

export function clampVector(vector: Vector3, maxLength: number): Vector3 {
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

export function rangeBetween(left: Vector3, right: Vector3): number {
  return vectorMagnitude({
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  });
}

export function meters(vector: Vector3): string {
  return `${vector.x.toFixed(0)}, ${vector.y.toFixed(0)}, ${vector.z.toFixed(0)}`;
}

export function formatDistance(distance: number): string {
  if (distance >= 1000) {
    return `${(distance / 1000).toFixed(1)} km`;
  }
  return `${Math.round(distance)} m`;
}

export function formatBearing(vector: Vector3): string {
  return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
}

export function surfaceBearing(latitude: number, longitude: number): Vector3 {
  const lat = (latitude * Math.PI) / 180;
  const lon = (longitude * Math.PI) / 180;
  return {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.sin(lat),
    z: Math.cos(lat) * Math.sin(lon),
  };
}

export function subtract(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

export function addVector(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

export function scaleVector(vector: Vector3, scale: number): Vector3 {
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

export function unit(vector: Vector3): Vector3 {
  const magnitude = vectorMagnitude(vector);
  if (magnitude <= 0.0001) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
