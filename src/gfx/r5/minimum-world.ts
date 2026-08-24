import * as THREE from "three";
import { MINIMUM_ENCOUNTERS, MINIMUM_SPEED_MM_PER_SECOND } from "@/src/game/r5/minimum-encounters";
import type { MinimumLoopState } from "@/src/game/r5/minimum-loop";
import {
  ConveyorRail,
  MINIMUM_FOV_EVALUATIONS,
  MINIMUM_NEAR_MARKER_CYCLE_MM,
  MINIMUM_NEAR_MARKER_SPACING_MM,
  MINIMUM_NEAR_RECYCLE_BEHIND_MM,
  MINIMUM_PLAYER_Z,
  MINIMUM_SELECTED_FOV,
  MINIMUM_WORLD_UNITS_PER_MM,
} from "./conveyor-rail";

export type ScreenBox = Readonly<{ x: number; y: number; width: number; height: number }>;
export type MinimumWorldTelemetry = Readonly<{
  player: ScreenBox;
  ring: ScreenBox;
  obstacle: ScreenBox;
  node: ScreenBox;
  encounterZ: Readonly<Record<"ring" | "obstacle" | "node", number>>;
  encounters: Readonly<Record<"ring" | "obstacle" | "node", RailPointTelemetry>>;
  layers: Readonly<{
    near: readonly RailPointTelemetry[];
    mid: readonly RailPointTelemetry[];
    far: RailPointTelemetry;
  }>;
  rail: Readonly<{
    playerZ: number;
    worldUnitsPerMm: number;
    selectedFovDegrees: number;
    fovEvaluations: typeof MINIMUM_FOV_EVALUATIONS;
    nearMarkerSpacingMm: number;
    nearMarkerPassIntervalMs: number;
    nearMarkerPassIndex: number;
    vanishingPoint: Readonly<{ x: number; y: number }>;
    reducedMotion: boolean;
  }>;
}>;

export type RailPointTelemetry = Readonly<{
  id: string;
  z: number;
  x: number;
  y: number;
  visible: boolean;
}>;

export type MinimumWorld = Readonly<{
  render(state: MinimumLoopState): void;
  telemetry(state: MinimumLoopState): MinimumWorldTelemetry;
  resize(): void;
  dispose(): void;
}>;

const rail = new ConveyorRail();
const MID_SPACING_MM = 1_800;
const MID_CYCLE_MM = MID_SPACING_MM * 6;
const MID_RECYCLE_BEHIND_MM = 4_200;
const FIRST_NEAR_PASS_MM = 360;
const FAR_LANDMARK_DISTANCE_MM = 36_000;

function dropletGeometry(): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.15);
  shape.bezierCurveTo(0.2, 0.7, 0.68, 0.25, 0.68, -0.35);
  shape.bezierCurveTo(0.68, -1.05, 0.25, -1.35, 0, -1.35);
  shape.bezierCurveTo(-0.25, -1.35, -0.68, -1.05, -0.68, -0.35);
  shape.bezierCurveTo(-0.68, 0.25, -0.2, 0.7, 0, 1.15);
  return new THREE.ShapeGeometry(shape, 20);
}

function screenBox(
  object: THREE.Object3D,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
): ScreenBox {
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object);
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const projected = [
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
    new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
    new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
  ].map((point) => point.project(camera));
  const left = Math.min(...projected.map((point) => ((point.x + 1) / 2) * width));
  const right = Math.max(...projected.map((point) => ((point.x + 1) / 2) * width));
  const top = Math.min(...projected.map((point) => ((1 - point.y) / 2) * height));
  const bottom = Math.max(...projected.map((point) => ((1 - point.y) / 2) * height));
  return Object.freeze({
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  });
}

function encounterZ(distanceMm: number, state: MinimumLoopState): number {
  return rail.zAt(distanceMm, state.distanceMm);
}

function screenPoint(
  object: THREE.Object3D,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
): RailPointTelemetry {
  object.updateWorldMatrix(true, false);
  camera.updateWorldMatrix(true, false);
  const point = new THREE.Vector3();
  object.getWorldPosition(point);
  const projected = point.project(camera);
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  return Object.freeze({
    id: object.name,
    z: point.z,
    x: ((projected.x + 1) / 2) * width,
    y: ((1 - projected.y) / 2) * height,
    visible: projected.z >= -1 && projected.z <= 1
      && projected.x >= -1.08 && projected.x <= 1.08
      && projected.y >= -1.08 && projected.y <= 1.08,
  });
}

function projectedWorldPoint(
  point: THREE.Vector3,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
): Readonly<{ x: number; y: number }> {
  camera.updateWorldMatrix(true, false);
  const projected = point.clone().project(camera);
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  return Object.freeze({
    x: ((projected.x + 1) / 2) * width,
    y: ((1 - projected.y) / 2) * height,
  });
}

export function createMinimumWorld(canvas: HTMLCanvasElement): MinimumWorld {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06141c);
  const camera = new THREE.PerspectiveCamera(MINIMUM_SELECTED_FOV, 1, 0.1, 90);
  camera.position.set(0, 2.6, 8.5);
  camera.lookAt(0, -0.35, -5.5);

  const grid = new THREE.GridHelper(36, 24, 0x1d6870, 0x12323c);
  grid.position.set(0, -2.45, -8);
  scene.add(grid);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x255868 });
  const markers: Array<{ object: THREE.Mesh; anchorDistanceMm: number }> = [];
  for (const x of [-5.2, 5.2]) {
    for (let index = 0; index < 12; index += 1) {
      const marker = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), markerMaterial);
      marker.name = `near-${x < 0 ? "left" : "right"}-${index}`;
      const anchorDistanceMm = FIRST_NEAR_PASS_MM + index * MINIMUM_NEAR_MARKER_SPACING_MM;
      marker.position.set(x, -2.05, rail.repeatedZAt(
        anchorDistanceMm,
        0,
        MINIMUM_NEAR_MARKER_CYCLE_MM,
        MINIMUM_NEAR_RECYCLE_BEHIND_MM,
      ));
      scene.add(marker);
      markers.push({ object: marker, anchorDistanceMm });
    }
  }
  const midMaterial = new THREE.MeshBasicMaterial({ color: 0x2e7887, wireframe: true });
  const midObjects: Array<{ object: THREE.Mesh; anchorDistanceMm: number }> = [];
  for (let index = 0; index < 6; index += 1) {
    const mid = new THREE.Mesh(new THREE.OctahedronGeometry(0.18 + (index % 3) * 0.06, 0), midMaterial);
    mid.name = `mid-${index}`;
    const anchorDistanceMm = 900 + index * MID_SPACING_MM;
    mid.position.set(((index * 47) % 100) / 12 - 4.2, -2.12 + (index % 2) * 0.2, rail.repeatedZAt(
      anchorDistanceMm,
      0,
      MID_CYCLE_MM,
      MID_RECYCLE_BEHIND_MM,
    ));
    scene.add(mid);
    midObjects.push({ object: mid, anchorDistanceMm });
  }

  const farLandmark = new THREE.Group();
  farLandmark.name = "far-landmark";
  const farMaterial = new THREE.MeshBasicMaterial({ color: 0x39727a });
  for (const x of [-0.32, 0, 0.32]) {
    const spire = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.3 - Math.abs(x), 0.16), farMaterial);
    spire.position.set(x, 0, 0);
    farLandmark.add(spire);
  }
  farLandmark.position.set(0, -1.35, rail.zAt(FAR_LANDMARK_DISTANCE_MM, 0));
  scene.add(farLandmark);

  const player = new THREE.Mesh(
    dropletGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x8ee8f2, side: THREE.DoubleSide }),
  );
  player.scale.setScalar(0.295);
  player.position.set(0, -1.35, MINIMUM_PLAYER_Z);
  scene.add(player);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.2, 0.16, 12, 40),
    new THREE.MeshBasicMaterial({ color: 0xf2d88e }),
  );
  ring.name = "ring";
  scene.add(ring);
  const obstacle = new THREE.Mesh(
    new THREE.DodecahedronGeometry(1.05, 0),
    new THREE.MeshBasicMaterial({ color: 0xc16f62 }),
  );
  obstacle.name = "obstacle";
  obstacle.rotation.set(0.3, 0.4, 0.15);
  scene.add(obstacle);
  const node = new THREE.Group();
  node.name = "node";
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.32, 18), new THREE.MeshBasicMaterial({ color: 0xb5f08b, side: THREE.DoubleSide }));
  node.add(core);
  for (let index = 0; index < 3; index += 1) {
    const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.45, 14), new THREE.MeshBasicMaterial({ color: 0x62b979, side: THREE.DoubleSide }));
    const angle = (index / 3) * Math.PI * 2 + Math.PI / 2;
    leaf.scale.set(0.55, 1.15, 1);
    leaf.position.set(Math.cos(angle) * 0.62, Math.sin(angle) * 0.62, -0.02);
    leaf.rotation.z = angle - Math.PI / 2;
    node.add(leaf);
  }
  scene.add(node);

  const pulse = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 0.78, 32),
    new THREE.MeshBasicMaterial({ color: 0xbffaff, transparent: true, opacity: 0, side: THREE.DoubleSide }),
  );
  pulse.position.copy(player.position);
  scene.add(pulse);

  let lastPulseMs: number | null = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const resize = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const place = (state: MinimumLoopState) => {
    const gridSpacingMm = 675;
    grid.position.z = -8 + ((state.distanceMm % gridSpacingMm) * MINIMUM_WORLD_UNITS_PER_MM);
    markers.forEach(({ object, anchorDistanceMm }) => {
      object.position.z = rail.repeatedZAt(
        anchorDistanceMm,
        state.distanceMm,
        MINIMUM_NEAR_MARKER_CYCLE_MM,
        MINIMUM_NEAR_RECYCLE_BEHIND_MM,
      );
    });
    midObjects.forEach(({ object, anchorDistanceMm }) => {
      object.position.z = rail.repeatedZAt(
        anchorDistanceMm,
        state.distanceMm,
        MID_CYCLE_MM,
        MID_RECYCLE_BEHIND_MM,
      );
    });
    farLandmark.position.z = rail.zAt(FAR_LANDMARK_DISTANCE_MM, state.distanceMm);
    player.position.x = (state.playerXPermille / 1_000) * 4.8;
    ring.position.set((MINIMUM_ENCOUNTERS.ring.xPermille / 1_000) * 4.8, -0.55, encounterZ(MINIMUM_ENCOUNTERS.ring.distanceMm, state));
    const ringApproach = Math.min(1, Math.max(0, state.distanceMm / MINIMUM_ENCOUNTERS.ring.distanceMm));
    ring.scale.setScalar(0.82 + ringApproach * 0.38);
    obstacle.position.set((MINIMUM_ENCOUNTERS.obstacle.xPermille / 1_000) * 4.8, -0.85, encounterZ(MINIMUM_ENCOUNTERS.obstacle.distanceMm, state));
    node.position.set((MINIMUM_ENCOUNTERS.node.xPermille / 1_000) * 4.8, -0.75, encounterZ(MINIMUM_ENCOUNTERS.node.distanceMm, state));
    if (state.lastPulseMs !== null && state.lastPulseMs !== lastPulseMs) lastPulseMs = state.lastPulseMs;
    const pulseAge = lastPulseMs === null ? Number.POSITIVE_INFINITY : state.timeMs - lastPulseMs;
    const pulseMaterial = pulse.material as THREE.MeshBasicMaterial;
    pulse.position.copy(player.position);
    pulse.scale.setScalar(1 + Math.max(0, pulseAge) / 180);
    pulseMaterial.opacity = pulseAge >= 0 && pulseAge <= 360 ? 1 - pulseAge / 360 : 0;
  };
  resize();
  return Object.freeze({
    render(state) {
      place(state);
      ring.rotation.z = 0;
      obstacle.rotation.y = reducedMotion ? 0.4 : state.timeMs * 0.00025;
      renderer.render(scene, camera);
    },
    telemetry(state) {
      place(state);
      return Object.freeze({
        player: screenBox(player, camera, canvas),
        ring: screenBox(ring, camera, canvas),
        obstacle: screenBox(obstacle, camera, canvas),
        node: screenBox(node, camera, canvas),
        encounterZ: Object.freeze({
          ring: ring.position.z,
          obstacle: obstacle.position.z,
          node: node.position.z,
        }),
        encounters: Object.freeze({
          ring: screenPoint(ring, camera, canvas),
          obstacle: screenPoint(obstacle, camera, canvas),
          node: screenPoint(node, camera, canvas),
        }),
        layers: Object.freeze({
          near: Object.freeze(markers.map(({ object }) => screenPoint(object, camera, canvas))),
          mid: Object.freeze(midObjects.map(({ object }) => screenPoint(object, camera, canvas))),
          far: screenPoint(farLandmark, camera, canvas),
        }),
        rail: Object.freeze({
          playerZ: rail.playerZ,
          worldUnitsPerMm: rail.worldUnitsPerMm,
          selectedFovDegrees: MINIMUM_SELECTED_FOV,
          fovEvaluations: MINIMUM_FOV_EVALUATIONS,
          nearMarkerSpacingMm: MINIMUM_NEAR_MARKER_SPACING_MM,
          nearMarkerPassIntervalMs: rail.passIntervalMs(
            MINIMUM_NEAR_MARKER_SPACING_MM,
            MINIMUM_SPEED_MM_PER_SECOND,
          ),
          nearMarkerPassIndex: rail.passIndex(
            state.distanceMm,
            MINIMUM_NEAR_MARKER_SPACING_MM,
            FIRST_NEAR_PASS_MM,
          ),
          vanishingPoint: projectedWorldPoint(new THREE.Vector3(0, -0.35, -70), camera, canvas),
          reducedMotion,
        }),
      });
    },
    resize,
    dispose() {
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
    },
  });
}
