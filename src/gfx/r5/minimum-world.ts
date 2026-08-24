import * as THREE from "three";
import { MINIMUM_ENCOUNTERS } from "@/src/game/r5/minimum-encounters";
import type { MinimumLoopState } from "@/src/game/r5/minimum-loop";

export type ScreenBox = Readonly<{ x: number; y: number; width: number; height: number }>;
export type MinimumWorldTelemetry = Readonly<{
  player: ScreenBox;
  ring: ScreenBox;
  obstacle: ScreenBox;
  node: ScreenBox;
  encounterZ: Readonly<Record<"ring" | "obstacle" | "node", number>>;
}>;

export type MinimumWorld = Readonly<{
  render(state: MinimumLoopState): void;
  telemetry(state: MinimumLoopState): MinimumWorldTelemetry;
  resize(): void;
  dispose(): void;
}>;

const WORLD_UNITS_PER_MM = 1 / 450;
const PLAYER_Z = 1.5;

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
  return PLAYER_Z - (distanceMm - state.distanceMm) * WORLD_UNITS_PER_MM;
}

export function createMinimumWorld(canvas: HTMLCanvasElement): MinimumWorld {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06141c);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 80);
  camera.position.set(0, 2.6, 8.5);
  camera.lookAt(0, -0.35, -5.5);

  const grid = new THREE.GridHelper(36, 24, 0x1d6870, 0x12323c);
  grid.position.set(0, -2.45, -8);
  scene.add(grid);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x255868 });
  const markers: Array<{ object: THREE.Mesh; baseZ: number }> = [];
  for (const x of [-5.2, 5.2]) {
    for (let z = -20; z <= 2; z += 4) {
      const marker = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), markerMaterial);
      marker.position.set(x, -2.05, z);
      scene.add(marker);
      markers.push({ object: marker, baseZ: z });
    }
  }
  const bubbleMaterial = new THREE.MeshBasicMaterial({ color: 0x2e7887, wireframe: true });
  const bubbles: Array<{ object: THREE.Mesh; baseZ: number }> = [];
  for (let index = 0; index < 12; index += 1) {
    const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.06 + (index % 3) * 0.025, 8, 6), bubbleMaterial);
    bubble.position.set(((index * 47) % 100) / 10 - 5, -1.5 + ((index * 29) % 35) / 10, -2 - (index % 6) * 3.2);
    scene.add(bubble);
    bubbles.push({ object: bubble, baseZ: bubble.position.z });
  }

  const player = new THREE.Mesh(
    dropletGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x8ee8f2, side: THREE.DoubleSide }),
  );
  player.scale.setScalar(0.22);
  player.position.set(0, -1.35, PLAYER_Z);
  scene.add(player);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.2, 0.16, 12, 40),
    new THREE.MeshBasicMaterial({ color: 0xf2d88e }),
  );
  scene.add(ring);
  const obstacle = new THREE.Mesh(
    new THREE.DodecahedronGeometry(1.05, 0),
    new THREE.MeshBasicMaterial({ color: 0xc16f62 }),
  );
  obstacle.rotation.set(0.3, 0.4, 0.15);
  scene.add(obstacle);
  const node = new THREE.Group();
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
  const resize = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const place = (state: MinimumLoopState) => {
    const worldTravel = state.distanceMm * WORLD_UNITS_PER_MM;
    const nearTravel = worldTravel * 1.5;
    grid.position.z = -8 + (nearTravel % 1.5);
    markers.forEach(({ object, baseZ }) => { object.position.z = baseZ + (nearTravel % 4); });
    bubbles.forEach(({ object, baseZ }) => { object.position.z = baseZ + (nearTravel % 19.2); });
    player.position.x = (state.playerXPermille / 1_000) * 4.8;
    ring.position.set((MINIMUM_ENCOUNTERS.ring.xPermille / 1_000) * 4.8, -0.55, encounterZ(MINIMUM_ENCOUNTERS.ring.distanceMm, state));
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
      ring.rotation.z = state.timeMs * 0.00018;
      obstacle.rotation.y = state.timeMs * 0.00025;
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
