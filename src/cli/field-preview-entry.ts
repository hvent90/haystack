// Browser entry for the field preview harness. Bun.build bundles this for the
// browser; render-field-preview.ts injects it into a headless page and calls
// window.renderFieldPreview(opts). Renders the factory's rocks as color-coded
// instanced spheres in a minimal Three.js WebGPU scene and returns PNG data
// URLs (one per shot, or one stitched contact sheet).
import * as THREE from "three/webgpu";

import { DEFAULT_GEOMETRY, rocksInSphere, type RockSpec } from "../shared/field-factory";
import { PRESETS } from "../shared/field-presets";

export type PreviewPanel = {
  label: string; // caption line, e.g. "2 km"
  camPos: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
  fov: number;
  queryRadius: number; // meters around lookAt to materialize
  // floor on rendered rock radius (meters) so distant rocks stay ≥ ~1px
  minWorldRadius: number;
};

export type PreviewOpts = {
  preset: string;
  caption: string; // headline drawn on the sheet (preset + params)
  panels: PreviewPanel[];
  panelWidth: number;
  panelHeight: number;
  stitch: boolean; // true → single contact-sheet PNG, false → one PNG per panel
};

export type PreviewShot = {
  name: string;
  dataUrl: string;
  rockCount: number;
};

// archetype → [base color, anchor color] (anchors/role-2 get the brighter tint)
const PALETTE: Record<string, [number, number]> = {
  pocket: [0xe08840, 0xffd9a0],
  filament: [0x3fb8c4, 0xb0f0f4],
  sheet: [0x9dc24a, 0xe4f4b0],
  "ring-arc": [0xb06ae0, 0xe8c8ff],
  drift: [0x6a86a8, 0xc4d4e8],
  base: [0x8a8a8a, 0xcccccc],
  "legacy-uniform": [0x9a9a9a, 0xdddddd],
};

function colorFor(rock: RockSpec): number {
  const pair = PALETTE[rock.archetype] ?? PALETTE["base"]!;
  return rock.role === 2 ? pair[1] : pair[0];
}

async function renderPanel(
  renderer: THREE.WebGPURenderer,
  panel: PreviewPanel,
  preset: string,
  width: number,
  height: number,
): Promise<{ canvas: HTMLCanvasElement; rockCount: number }> {
  const presetDef = PRESETS[preset];
  if (presetDef === undefined) {
    throw new Error(`unknown preset: ${preset}`);
  }
  const rocks = rocksInSphere(DEFAULT_GEOMETRY, presetDef, panel.lookAt, panel.queryRadius);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070c);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
  sun.position.set(0.6, 0.8, 0.4);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x3a4a66, 0.5));

  const geometry = new THREE.SphereGeometry(1, 10, 7);
  const material = new THREE.MeshStandardMaterial({
    flatShading: true,
    roughness: 0.95,
    metalness: 0.05,
    emissive: 0x16181f, // keep unlit sides faintly visible against the void
  });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, rocks.length));
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let i = 0; i < rocks.length; i += 1) {
    const rock = rocks[i]!;
    const s = Math.max(rock.radius, panel.minWorldRadius);
    matrix.makeScale(s, s, s);
    matrix.setPosition(rock.position.x, rock.position.y, rock.position.z);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, color.setHex(colorFor(rocks[i]!)));
  }
  if (rocks.length === 0) {
    matrix.makeScale(1e-6, 1e-6, 1e-6);
    matrix.setPosition(0, 1e9, 0);
    mesh.setMatrixAt(0, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  const dist = Math.hypot(
    panel.camPos.x - panel.lookAt.x,
    panel.camPos.y - panel.lookAt.y,
    panel.camPos.z - panel.lookAt.z,
  );
  // clip foreground rocks near the camera — at wide zooms they project huge
  // and hide the structure the panel exists to show
  const camera = new THREE.PerspectiveCamera(panel.fov, width / height, Math.max(10, dist * 0.12), 5e6);
  camera.position.set(panel.camPos.x, panel.camPos.y, panel.camPos.z);
  camera.lookAt(panel.lookAt.x, panel.lookAt.y, panel.lookAt.z);

  renderer.setSize(width, height, false);
  await renderer.renderAsync(scene, camera);

  // copy the WebGPU canvas into a 2D canvas immediately (the drawing buffer
  // is only guaranteed alive in the same task as the render)
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  const ctx = copy.getContext("2d")!;
  ctx.drawImage(renderer.domElement, 0, 0);

  geometry.dispose();
  material.dispose();
  return { canvas: copy, rockCount: rocks.length };
}

function caption(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 18): void {
  ctx.font = `${size}px Menlo, monospace`;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  const w = ctx.measureText(text).width;
  ctx.fillRect(x - 6, y - size - 4, w + 12, size + 12);
  ctx.fillStyle = "#e8eef8";
  ctx.fillText(text, x, y);
}

export async function renderFieldPreview(opts: PreviewOpts): Promise<PreviewShot[]> {
  const canvas = document.createElement("canvas");
  canvas.width = opts.panelWidth;
  canvas.height = opts.panelHeight;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  const backend = renderer.backend as { isWebGPUBackend?: boolean };
  console.warn(`[preview] backend: ${backend.isWebGPUBackend === true ? "webgpu" : "webgl-fallback"}`);

  const shots: PreviewShot[] = [];
  const panels: Array<{ canvas: HTMLCanvasElement; rockCount: number; panel: PreviewPanel }> = [];
  for (const panel of opts.panels) {
    const result = await renderPanel(renderer, panel, opts.preset, opts.panelWidth, opts.panelHeight);
    panels.push({ ...result, panel });
  }

  if (opts.stitch) {
    const sheet = document.createElement("canvas");
    sheet.width = opts.panelWidth * panels.length;
    sheet.height = opts.panelHeight + 34;
    const ctx = sheet.getContext("2d")!;
    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    for (let i = 0; i < panels.length; i += 1) {
      const p = panels[i]!;
      ctx.drawImage(p.canvas, i * opts.panelWidth, 34);
      caption(
        ctx,
        `${p.panel.label}  ·  ${p.rockCount} rocks`,
        i * opts.panelWidth + 14,
        34 + 28,
      );
    }
    caption(ctx, opts.caption, 14, 24, 19);
    shots.push({
      name: opts.preset,
      dataUrl: sheet.toDataURL("image/png"),
      rockCount: panels.reduce((sum, p) => sum + p.rockCount, 0),
    });
  } else {
    for (const p of panels) {
      const single = document.createElement("canvas");
      single.width = opts.panelWidth;
      single.height = opts.panelHeight;
      const ctx = single.getContext("2d")!;
      ctx.drawImage(p.canvas, 0, 0);
      caption(ctx, `${opts.caption}  ·  ${p.panel.label}  ·  ${p.rockCount} rocks`, 14, 26);
      shots.push({
        name: `${opts.preset}-${p.panel.label.replace(/[^a-z0-9]+/gi, "-")}`,
        dataUrl: single.toDataURL("image/png"),
        rockCount: p.rockCount,
      });
    }
  }

  renderer.dispose();
  return shots;
}

declare global {
  interface Window {
    renderFieldPreview?: (opts: PreviewOpts) => Promise<PreviewShot[]>;
  }
}

if (typeof window !== "undefined") {
  window.renderFieldPreview = renderFieldPreview;
}
