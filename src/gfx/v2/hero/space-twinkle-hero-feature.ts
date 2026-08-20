import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
} from "three/webgpu";
import { float } from "three/tsl";
import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderFeature,
  RenderHistoryInvalidation,
  RenderPassRecorder,
  RenderQualityProfile,
  RenderViewport,
  VisualClock,
} from "../contracts";
import type { WorldPlan } from "../../../world/v2";

const DEFAULT_MARKER_SECONDS = 142;
const DEBRIS_START_SECONDS = 130;
const DEBRIS_END_SECONDS = 155;
const NEBULA_START_SECONDS = 148;
const PREVIEW_START_SECONDS = 155;
const SHIP_REVEAL_SECONDS = 161;
const ANSWER_WINDOW_SECONDS = 166;
const TWINKLE_START_SECONDS = 171;
const FINAL_TITLE_SECONDS = 178;
const MAX_TWINKLES = 160;
const ALIEN_SHELL_COUNT = 3;
const ALIEN_RIBBON_THICKNESS = 0.1;
const HUMAN_DEBRIS_FORMS = 7;
const TAU = Math.PI * 2;

type HeroLifecycle = "new" | "ready" | "disposing" | "disposed" | "failed";
type TwinkleStage = "none" | "one" | "few" | "tens" | "many";

interface HeroOwnedMaterial {
  readonly material: Material;
  disposed: boolean;
}

interface HeroOwnedGeometry {
  readonly geometry: BufferGeometry;
  disposed: boolean;
}

interface AlienRibbonGeometryResult {
  readonly geometry: BufferGeometry;
  readonly minimumVertexRadius: number;
  readonly seamPositionError: number;
  readonly seamNormalDot: number;
  readonly holonomyCorrectionRadians: number;
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly degenerateTriangleCount: number;
}

interface DeterministicRandom {
  next(): number;
  range(minimum: number, maximum: number): number;
}

export interface SpaceTwinkleHeroFeatureSnapshot {
  readonly state: HeroLifecycle;
  readonly storyTime: number;
  readonly shotId: string;
  readonly qualityTier: RenderQualityProfile["tier"];
  readonly humanDebrisVisible: boolean;
  readonly humanDebrisForms: number;
  readonly humanGrammarRectilinear: boolean;
  readonly solarPanels: number;
  readonly straightTrusses: number;
  readonly habitatModules: number;
  readonly slabRadiators: number;
  readonly rectangularAirlocks: number;
  readonly brokenObservationFrames: number;
  readonly emptyCockpits: number;
  readonly amberBeaconVisible: boolean;
  readonly machineReactivated: boolean;
  readonly nebulaVisible: boolean;
  readonly darkNegativeSpaceClear: boolean;
  readonly peripheralArcsVisible: boolean;
  readonly peripheralArcCount: number;
  readonly peripheralArcsIncomplete: boolean;
  readonly unknownShipVisible: boolean;
  readonly alienRibbonShellCount: number;
  readonly alienRibbonInventory: number;
  readonly closedBsplineShells: boolean;
  readonly parallelTransportFrames: boolean;
  readonly constrainedSuperformulaSections: boolean;
  readonly ribbonThickness: number;
  readonly centralVoidOpen: boolean;
  readonly minimumShipVertexRadius: number;
  readonly ribbonTopologyManifold: boolean;
  readonly ribbonBoundaryEdges: number;
  readonly ribbonNonManifoldEdges: number;
  readonly ribbonDegenerateTriangles: number;
  readonly ribbonMaximumSeamPositionError: number;
  readonly ribbonMinimumSeamNormalDot: number;
  readonly ribbonMaximumHolonomyCorrection: number;
  readonly alienUsesHumanGrammar: boolean;
  readonly alienHasCockpitWindowThrusterOrFront: boolean;
  readonly responseWindowOpen: boolean;
  readonly answerReceived: boolean;
  readonly alienResponseVisible: boolean;
  readonly protagonistVisible: boolean;
  readonly protagonistWingsOpen: boolean;
  readonly earthVisible: boolean;
  readonly twinkleStage: TwinkleStage;
  readonly visibleTwinkles: number;
  readonly twinkleSourceCount: number;
  readonly ledgerOrderPreserved: boolean;
  readonly finalLifeLightsTemporalStable: boolean;
  readonly formalTitleVisible: boolean;
  readonly visibleDistantStars: number;
  readonly ownedGeometries: number;
  readonly ownedMaterials: number;
  readonly ownedTextures: number;
  readonly ownedObjects: number;
  readonly allocationsAfterInitialize: number;
}

function randomFrom(seed: number): DeterministicRandom {
  let state = (seed >>> 0) || 0x9e37_79b9;
  return Object.freeze({
    next() {
      state = (state + 0x6d2b_79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    },
    range(minimum: number, maximum: number) {
      return minimum + (maximum - minimum) * this.next();
    },
  });
}

function mix32(value: number): number {
  let mixed = Math.imul(value ^ (value >>> 16), 0x7feb_352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846c_a68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function hashedUnit(x: number, y: number, seed: number): number {
  return mix32(
    seed
    ^ Math.imul(x + 1, 0x85eb_ca6b)
    ^ Math.imul(y + 1, 0xc2b2_ae35),
  ) / 0x1_0000_0000;
}

function organicAsteroidGeometry(seed: number): IcosahedronGeometry {
  const geometry = new IcosahedronGeometry(0.55, 2);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const longitude = Math.round((Math.atan2(z, x) + Math.PI) * 2_048);
    const latitude = Math.round((y + 0.75) * 4_096);
    const variation = 0.76 + hashedUnit(longitude, latitude, seed) * 0.42;
    positions.setXYZ(index, x * variation, y * variation * 0.84, z * variation * 1.08);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function nebulaLobeGeometry(seed: number): SphereGeometry {
  const radius = 1;
  const geometry = new SphereGeometry(radius, 40, 28);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const longitude = Math.round((Math.atan2(z, x) + Math.PI) * 1_024);
    const latitude = Math.round((y + radius) * 2_048);
    const lowFrequency = Math.sin(longitude * 0.006 + seed * 0.000_013) * 0.055;
    const variation = 0.89
      + lowFrequency
      + hashedUnit(longitude, latitude, seed) * 0.14;
    positions.setXYZ(index, x * variation, y * variation, z * variation);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function livingDropletGeometry(): SphereGeometry {
  const radius = 0.7;
  const geometry = new SphereGeometry(radius, 24, 18);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const normalizedY = y / radius;
    const lowerTaper = normalizedY < -0.08
      ? Math.max(0.4, 1 + (normalizedY + 0.08) * 0.58)
      : 1;
    positions.setXYZ(
      index,
      x * lowerTaper * (1 + Math.sin(normalizedY * 4.8) * 0.035),
      y + (1 - Math.abs(normalizedY)) * 0.04,
      z * lowerTaper,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function livingEarthGeometry(seed: number): SphereGeometry {
  const radius = 1.58;
  const geometry = new SphereGeometry(radius, 40, 28);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const color = new Color();
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index) / radius;
    const y = positions.getY(index) / radius;
    const z = positions.getZ(index) / radius;
    const longitude = Math.atan2(z, x);
    const continent = Math.sin(longitude * 2.4 + y * 4.8 + seed * 0.000_002)
      + Math.cos(longitude * 5.1 - y * 3.2) * 0.58
      + Math.sin((x + z) * 7.2) * 0.24;
    if (Math.abs(y) > 0.82) {
      color.setHex(0xdce8df);
    } else if (continent > 0.58) {
      const warmth = Math.max(0, Math.min(1, (continent - 0.58) * 1.7));
      color.setRGB(0.12 + warmth * 0.12, 0.32 + warmth * 0.16, 0.13 + warmth * 0.05);
    } else {
      const depth = Math.max(0, Math.min(1, -continent * 0.22 + 0.38));
      color.setRGB(0.045, 0.2 + depth * 0.13, 0.37 + depth * 0.22);
    }
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

function finiteStoryTime(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MARKER_SECONDS;
  return Math.max(0, Math.min(180, value));
}

function standardMaterial(
  color: number,
  roughness: number,
  metalness = 0,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  material.color.setHex(color);
  material.roughness = roughness;
  material.metalness = metalness;
  material.toneMapped = true;
  return material;
}

function physicalMaterial(
  color: number,
  opacity: number,
  roughness: number,
  metalness: number,
): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial();
  material.color.setHex(color);
  material.roughness = roughness;
  material.metalness = metalness;
  material.transparent = opacity < 1;
  material.opacity = opacity;
  material.depthWrite = opacity >= 0.88;
  material.side = DoubleSide;
  material.toneMapped = true;
  return material;
}

function additiveMaterial(color: number, opacity: number): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.color.setHex(color);
  material.transparent = true;
  material.opacity = opacity;
  material.depthWrite = false;
  material.side = DoubleSide;
  material.blending = AdditiveBlending;
  material.toneMapped = false;
  return material;
}

function superformulaRadius(theta: number, shellIndex: number): number {
  const m = 4 + shellIndex * 2;
  const n1 = 5.2 + shellIndex * 0.55;
  const n2 = 7.4;
  const n3 = 7.4;
  const left = Math.abs(Math.cos((m * theta) / 4));
  const right = Math.abs(Math.sin((m * theta) / 4));
  const raw = (left ** n2 + right ** n3) ** (-1 / n1);
  return Math.max(0.82, Math.min(1.16, raw));
}

function evaluateClosedUniformCubicBspline(
  points: readonly Vector3[],
  t: number,
  target: Vector3,
): Vector3 {
  const count = points.length;
  const scaled = ((t % 1) + 1) % 1 * count;
  const index = Math.floor(scaled);
  const u = scaled - index;
  const u2 = u * u;
  const u3 = u2 * u;
  const basis0 = (1 - 3 * u + 3 * u2 - u3) / 6;
  const basis1 = (4 - 6 * u2 + 3 * u3) / 6;
  const basis2 = (1 + 3 * u + 3 * u2 - 3 * u3) / 6;
  const basis3 = u3 / 6;
  const p0 = points[(index - 1 + count) % count]!;
  const p1 = points[index % count]!;
  const p2 = points[(index + 1) % count]!;
  const p3 = points[(index + 2) % count]!;
  return target.set(0, 0, 0)
    .addScaledVector(p0, basis0)
    .addScaledVector(p1, basis1)
    .addScaledVector(p2, basis2)
    .addScaledVector(p3, basis3);
}

function buildAlienRibbonGeometry(shellIndex: number): AlienRibbonGeometryResult {
  const controlPoints: Vector3[] = [];
  const controlCount = 12;
  const phase = (shellIndex / ALIEN_SHELL_COUNT) * TAU;
  const radiusX = [4.05, 3.7, 3.9][shellIndex]!;
  const radiusY = [2.48, 2.84, 2.62][shellIndex]!;
  for (let index = 0; index < controlCount; index += 1) {
    const angle = (index / controlCount) * TAU + phase * 0.21;
    const breathing = 1
      + Math.sin(angle * (3 + shellIndex) + phase) * 0.055
      + Math.cos(angle * 2 - phase) * 0.025;
    controlPoints.push(new Vector3(
      Math.cos(angle) * radiusX * breathing,
      Math.sin(angle) * radiusY * breathing,
      Math.sin(angle * (2 + shellIndex) + phase) * (0.48 + shellIndex * 0.12)
        + Math.cos(angle + phase) * 0.12,
    ));
  }

  const segments = 144;
  const acrossSegments = 10;
  const centers: Vector3[] = [];
  const tangents: Vector3[] = [];
  const normals: Vector3[] = [];
  const binormals: Vector3[] = [];
  const before = new Vector3();
  const after = new Vector3();
  const tangent = new Vector3();
  const transported = new Vector3();
  const rotation = new Quaternion();
  const up = new Vector3(0, 0, 1);
  const fallback = new Vector3(0, 1, 0);

  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    centers.push(evaluateClosedUniformCubicBspline(controlPoints, t, new Vector3()));
    evaluateClosedUniformCubicBspline(controlPoints, t - 0.0005, before);
    evaluateClosedUniformCubicBspline(controlPoints, t + 0.0005, after);
    tangent.subVectors(after, before).normalize();
    tangents.push(tangent.clone());
    if (index === 0) {
      transported.crossVectors(tangent, up);
      if (transported.lengthSq() < 0.0001) transported.crossVectors(tangent, fallback);
      normals.push(transported.normalize().clone());
    } else {
      rotation.setFromUnitVectors(tangents[index - 1]!, tangent);
      transported.copy(normals[index - 1]!).applyQuaternion(rotation).normalize();
      normals.push(transported.clone());
    }
    binormals.push(new Vector3().crossVectors(tangent, normals[index]!).normalize());
    normals[index]!.crossVectors(binormals[index]!, tangent).normalize();
  }

  const seamPositionError = centers[segments]!.distanceTo(centers[0]!);
  const closingNormal = normals[segments]!;
  const initialNormal = normals[0]!;
  const seamCross = new Vector3().crossVectors(closingNormal, initialNormal);
  const seamDotBeforeCorrection = Math.max(-1, Math.min(1, closingNormal.dot(initialNormal)));
  const holonomyCorrectionRadians = Math.atan2(
    tangents[0]!.dot(seamCross),
    seamDotBeforeCorrection,
  );
  const twist = new Quaternion();
  for (let index = 1; index <= segments; index += 1) {
    twist.setFromAxisAngle(
      tangents[index]!,
      holonomyCorrectionRadians * (index / segments),
    );
    normals[index]!.applyQuaternion(twist).normalize();
    binormals[index]!.crossVectors(tangents[index]!, normals[index]!).normalize();
    normals[index]!.crossVectors(binormals[index]!, tangents[index]!).normalize();
  }
  const seamNormalDot = Math.max(-1, Math.min(1, normals[segments]!.dot(normals[0]!)));

  const longitudinalCount = segments;
  const acrossCount = acrossSegments + 1;
  const layerSize = longitudinalCount * acrossCount;
  const positions: number[] = [];
  const colors: number[] = [];
  const shellHues = [0.48, 0.84, 0.105] as const;
  const vertexColor = new Color();
  let minimumVertexRadius = Number.POSITIVE_INFINITY;
  const vertex = new Vector3();
  for (let layer = 0; layer < 2; layer += 1) {
    const thicknessOffset = (layer === 0 ? 0.5 : -0.5) * ALIEN_RIBBON_THICKNESS;
    for (let along = 0; along < segments; along += 1) {
      const theta = (along / segments) * TAU;
      const width = (0.35 + shellIndex * 0.024) * superformulaRadius(theta + phase, shellIndex);
      for (let across = 0; across <= acrossSegments; across += 1) {
        const lateral = -1 + (across / acrossSegments) * 2;
        const surfaceRipple = Math.sin(
          theta * (5 + shellIndex * 2) + lateral * 2.2 + phase,
        ) * 0.018 * (1 - Math.abs(lateral) * 0.3);
        vertex.copy(centers[along]!)
          .addScaledVector(normals[along]!, lateral * width)
          .addScaledVector(binormals[along]!, thicknessOffset + surfaceRipple);
        positions.push(vertex.x, vertex.y, vertex.z);
        const shimmer = 0.5 + Math.sin(
          theta * (3 + shellIndex) - lateral * 1.8 + layer * 0.7,
        ) * 0.5;
        const edgeLight = 1 - Math.abs(lateral) * 0.42;
        vertexColor.setHSL(
          shellHues[shellIndex]! + Math.sin(theta * 2 + phase) * 0.012,
          0.2,
          0.48 + shimmer * 0.1 + edgeLight * 0.05,
        );
        colors.push(vertexColor.r, vertexColor.g, vertexColor.b);
        minimumVertexRadius = Math.min(minimumVertexRadius, vertex.length());
      }
    }
  }

  const indices: number[] = [];
  const topIndex = (along: number, across: number) => along * acrossCount + across;
  const bottomIndex = (along: number, across: number) => layerSize + along * acrossCount + across;
  for (let along = 0; along < segments; along += 1) {
    const nextAlong = (along + 1) % segments;
    for (let across = 0; across < acrossSegments; across += 1) {
      const a = topIndex(along, across);
      const b = topIndex(nextAlong, across);
      const c = topIndex(nextAlong, across + 1);
      const d = topIndex(along, across + 1);
      indices.push(a, b, d, b, c, d);
      const ab = bottomIndex(along, across);
      const bb = bottomIndex(nextAlong, across);
      const cb = bottomIndex(nextAlong, across + 1);
      const db = bottomIndex(along, across + 1);
      indices.push(ab, db, bb, bb, db, cb);
    }
    for (const across of [0, acrossSegments]) {
      const topA = topIndex(along, across);
      const topB = topIndex(nextAlong, across);
      const bottomA = bottomIndex(along, across);
      const bottomB = bottomIndex(nextAlong, across);
      if (across === 0) {
        indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
      } else {
        indices.push(topA, topB, bottomA, topB, bottomB, bottomA);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const edgeIncidence = new Map<string, number>();
  const edge = (a: number, b: number): void => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    edgeIncidence.set(key, (edgeIncidence.get(key) ?? 0) + 1);
  };
  const pa = new Vector3();
  const pb = new Vector3();
  const pc = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  let degenerateTriangleCount = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]!;
    const b = indices[offset + 1]!;
    const c = indices[offset + 2]!;
    edge(a, b);
    edge(b, c);
    edge(c, a);
    pa.fromArray(positions, a * 3);
    pb.fromArray(positions, b * 3);
    pc.fromArray(positions, c * 3);
    ab.subVectors(pb, pa);
    ac.subVectors(pc, pa);
    if (ab.cross(ac).lengthSq() <= 1e-12) degenerateTriangleCount += 1;
  }
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const incidence of edgeIncidence.values()) {
    if (incidence === 1) boundaryEdgeCount += 1;
    else if (incidence !== 2) nonManifoldEdgeCount += 1;
  }
  return Object.freeze({
    geometry,
    minimumVertexRadius,
    seamPositionError,
    seamNormalDot,
    holonomyCorrectionRadians,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    degenerateTriangleCount,
  });
}

function freezeSnapshot(
  input: SpaceTwinkleHeroFeatureSnapshot,
): Readonly<SpaceTwinkleHeroFeatureSnapshot> {
  return Object.freeze({ ...input });
}

/**
 * Preallocated R2-G5 human-debris/alien/Twinkle realization. Canonical story,
 * pulse ledger, and world data stay renderer-independent. Update, quality,
 * resize, and render mutate only pre-existing transforms, visibility, counts,
 * colors, and uniforms.
 */
export class SpaceTwinkleHeroFeature implements RenderFeature {
  readonly id = "hero-slice-c-space-twinkle";
  readonly #scene: Scene;
  readonly #camera: PerspectiveCamera;
  readonly #root = new Group();
  readonly #debrisRoot = new Group();
  readonly #nebulaRoot = new Group();
  readonly #previewRoot = new Group();
  readonly #alienRoot = new Group();
  readonly #twinkleRoot = new Group();
  readonly #earthRoot = new Group();
  readonly #protagonistRoot = new Group();
  readonly #pulseRoot = new Group();
  readonly #materials: HeroOwnedMaterial[] = [];
  readonly #geometries: HeroOwnedGeometry[] = [];
  readonly #shellMaterials: MeshStandardNodeMaterial[] = [];
  readonly #previewArcs: Mesh[] = [];
  readonly #distantStars: InstancedMesh;
  readonly #twinkleMesh: InstancedMesh;
  readonly #twinkleDummy = new Object3D();
  readonly #twinkleColors = Object.freeze([
    new Color(0xffd9a0),
    new Color(0x72e0d2),
    new Color(0xf68c86),
    new Color(0xc7b3ff),
  ]);
  readonly #leftWing: Mesh;
  readonly #rightWing: Mesh;
  readonly #pulseRing: Mesh;
  readonly #backgroundColor = new Color(0x03040b);
  readonly #spaceFog = new FogExp2(0x03040b, 0.006);
  readonly #originalBackground: Scene["background"];
  readonly #originalFog: Scene["fog"];
  readonly #ambient: AmbientLight;
  readonly #hemisphere: HemisphereLight;
  readonly #keyLight: DirectionalLight;
  readonly #alienLight: PointLight;
  readonly #beaconLight: PointLight;
  readonly #earthLight: PointLight;
  readonly #minimumShipVertexRadius: number;
  readonly #ribbonBoundaryEdges: number;
  readonly #ribbonNonManifoldEdges: number;
  readonly #ribbonDegenerateTriangles: number;
  readonly #ribbonMaximumSeamPositionError: number;
  readonly #ribbonMinimumSeamNormalDot: number;
  readonly #ribbonMaximumHolonomyCorrection: number;
  #state: HeroLifecycle = "new";
  #storyTime = DEFAULT_MARKER_SECONDS;
  #shotId = "S18";
  #qualityTier: RenderQualityProfile["tier"] = "high";
  #twinkleStage: TwinkleStage = "none";
  #twinkleSourceCount = 0;
  #ledgerOrderPreserved = true;
  #answerReceived = false;
  #hasStoryUpdate = false;
  #initializedAllocations = 0;
  #disposePromise: Promise<void> | null = null;

  constructor(scene: Scene, camera: PerspectiveCamera, plan: Readonly<WorldPlan>) {
    this.#scene = scene;
    this.#camera = camera;
    this.#originalBackground = scene.background;
    this.#originalFog = scene.fog;
    scene.background = this.#backgroundColor;
    scene.fog = this.#spaceFog;

    const spaceChunk = plan.chunks.find((chunk) => chunk.id === "S18");
    const seed = spaceChunk?.environment.space.seedFingerprint ?? Number(plan.worldSeed);
    const random = randomFrom(seed);

    this.#root.name = "hero-c:space-twinkle-root";
    this.#debrisRoot.name = "hero-c:rectilinear-human-debris";
    this.#nebulaRoot.name = "hero-c:peripheral-nebula";
    this.#previewRoot.name = "hero-c:s20-incomplete-arcs";
    this.#alienRoot.name = "hero-c:three-ribbon-alien";
    this.#twinkleRoot.name = "hero-c:ledger-twinkles";
    this.#earthRoot.name = "hero-c:living-earth";
    this.#protagonistRoot.name = "hero-c:life-droplet";
    this.#pulseRoot.name = "hero-c:answer-pulse";
    this.#root.add(
      this.#nebulaRoot,
      this.#debrisRoot,
      this.#previewRoot,
      this.#earthRoot,
      this.#twinkleRoot,
      this.#alienRoot,
      this.#protagonistRoot,
      this.#pulseRoot,
    );
    scene.add(this.#root);

    this.#ambient = new AmbientLight(0x56638a, 0.32);
    this.#ambient.name = "hero-c:deep-space-ambient";
    this.#hemisphere = new HemisphereLight(0x88b7d6, 0x09050d, 0.72);
    this.#hemisphere.name = "hero-c:nebula-hemisphere";
    this.#keyLight = new DirectionalLight(0xbdd8ff, 2.7);
    this.#keyLight.name = "hero-c:distant-sun";
    this.#keyLight.position.set(-8, 9, 10);
    this.#alienLight = new PointLight(0x75d8d0, 1.1, 12, 1.5);
    this.#alienLight.name = "hero-c:alien-recognition-light";
    this.#alienLight.position.set(1.7, 0.15, -1.8);
    this.#beaconLight = new PointLight(0xffa64d, 1.1, 5, 2);
    this.#beaconLight.name = "hero-c:single-dying-beacon";
    this.#earthLight = new PointLight(0x9ad9ff, 1.1, 15, 1.5);
    this.#earthLight.name = "hero-c:earth-life-light";
    this.#earthLight.position.set(4.7, -1.2, -4.7);
    // Keep the light inventory attached to an always-visible parent. Runtime
    // story visibility may hide the lit subjects, but it must not change the
    // shader's point-light cardinality after the ready-time warm-up.
    this.#root.add(this.#alienLight, this.#beaconLight, this.#earthLight);
    scene.add(this.#ambient, this.#hemisphere, this.#keyLight);

    const distantStarGeometry = this.#ownGeometry(new IcosahedronGeometry(0.045, 1));
    const distantStarMaterial = this.#ownMaterial(additiveMaterial(0xd8e7ff, 0.64));
    const distantStars = this.#distantStars = new InstancedMesh(
      distantStarGeometry,
      distantStarMaterial,
      180,
    );
    distantStars.name = "hero-c:distant-starfield";
    const distantStarDummy = new Object3D();
    const starColors = [
      new Color(0xd8e7ff),
      new Color(0xffd9ad),
      new Color(0x9ee7dc),
      new Color(0xc8b8ff),
    ] as const;
    for (let index = 0; index < 180; index += 1) {
      const xUnit = hashedUnit(index, 0, seed ^ 0x53ac_190d);
      const yUnit = hashedUnit(index, 1, seed ^ 0x8e21_b746);
      let x = (xUnit * 2 - 1) * 13.4;
      const y = (yUnit * 2 - 1) * 7.2;
      if ((x - 1.7) ** 2 + (y - 0.15) ** 2 < 10.5) {
        x += x < 1.7 ? -4.2 : 4.2;
      }
      distantStarDummy.position.set(
        x,
        y,
        -9.5 - hashedUnit(index, 2, seed ^ 0x319d_65c2) * 10.5,
      );
      const scale = 0.45 + hashedUnit(index, 3, seed ^ 0xb817_42e3) * 1.5;
      distantStarDummy.scale.setScalar(scale);
      distantStarDummy.rotation.set(0, 0, hashedUnit(index, 4, seed) * TAU);
      distantStarDummy.updateMatrix();
      distantStars.setMatrixAt(index, distantStarDummy.matrix);
      distantStars.setColorAt(index, starColors[index % starColors.length]!);
    }
    distantStars.instanceMatrix.needsUpdate = true;
    if (distantStars.instanceColor) distantStars.instanceColor.needsUpdate = true;
    this.#root.add(distantStars);

    const humanMetal = this.#ownMaterial(standardMaterial(0x5b6471, 0.68, 0.72));
    const humanPanel = this.#ownMaterial(standardMaterial(0x243b57, 0.48, 0.52));
    const humanLight = this.#ownMaterial(standardMaterial(0x6f431d, 0.35, 0.4));
    humanLight.emissive.setHex(0x6b2a08);
    humanLight.emissiveIntensity = 0.42;
    const humanVoid = this.#ownMaterial(standardMaterial(0x06070a, 0.98, 0.02));
    const asteroidMaterial = this.#ownMaterial(standardMaterial(0x393b44, 0.96, 0.08));
    const box = this.#ownGeometry(new BoxGeometry(1, 1, 1));
    const panel = this.#ownGeometry(new PlaneGeometry(1, 1, 1, 1));
    this.#buildHumanDebris(box, panel, humanMetal, humanPanel, humanLight, humanVoid);

    const asteroidGeometry = this.#ownGeometry(organicAsteroidGeometry(seed ^ 0x6d91_3ac7));
    const asteroids = new InstancedMesh(asteroidGeometry, asteroidMaterial, 18);
    asteroids.name = "hero-c:nonuniform-asteroid-field";
    const asteroidDummy = new Object3D();
    for (let index = 0; index < 18; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      asteroidDummy.position.set(
        side * random.range(4.1, 9.2),
        random.range(-4.7, 4.9),
        random.range(-7.5, -1.5),
      );
      asteroidDummy.rotation.set(random.next() * TAU, random.next() * TAU, random.next() * TAU);
      asteroidDummy.scale.setScalar(random.range(0.35, 1.25));
      asteroidDummy.updateMatrix();
      asteroids.setMatrixAt(index, asteroidDummy.matrix);
    }
    asteroids.instanceMatrix.needsUpdate = true;
    this.#debrisRoot.add(asteroids);

    this.#buildNebula(seed);
    this.#buildPreviewArcs();

    let minimumShipVertexRadius = Number.POSITIVE_INFINITY;
    let ribbonBoundaryEdges = 0;
    let ribbonNonManifoldEdges = 0;
    let ribbonDegenerateTriangles = 0;
    let ribbonMaximumSeamPositionError = 0;
    let ribbonMinimumSeamNormalDot = 1;
    let ribbonMaximumHolonomyCorrection = 0;
    const shellBase = [0x35615d, 0x66364a, 0x6a512d] as const;
    const shellEmissive = [0x0b514a, 0x591c30, 0x694017] as const;
    const shellRotations = [
      [-0.31, 0.18, -0.24],
      [0.24, -0.28, 0.54],
      [0.08, 0.34, -0.68],
    ] as const;
    for (let shellIndex = 0; shellIndex < ALIEN_SHELL_COUNT; shellIndex += 1) {
      const built = buildAlienRibbonGeometry(shellIndex);
      ribbonBoundaryEdges += built.boundaryEdgeCount;
      ribbonNonManifoldEdges += built.nonManifoldEdgeCount;
      ribbonDegenerateTriangles += built.degenerateTriangleCount;
      ribbonMaximumSeamPositionError = Math.max(
        ribbonMaximumSeamPositionError,
        built.seamPositionError,
      );
      ribbonMinimumSeamNormalDot = Math.min(ribbonMinimumSeamNormalDot, built.seamNormalDot);
      ribbonMaximumHolonomyCorrection = Math.max(
        ribbonMaximumHolonomyCorrection,
        Math.abs(built.holonomyCorrectionRadians),
      );
      const geometry = this.#ownGeometry(built.geometry);
      geometry.name = `hero-c:closed-bspline-ribbon-${shellIndex + 1}`;
      const material = this.#ownMaterial(physicalMaterial(shellBase[shellIndex]!, 1, 0.3, 0.14));
      material.name = `hero-c:pearl-mineral-shell-${shellIndex + 1}`;
      material.vertexColors = true;
      material.opacityNode = float(0.6 + shellIndex * 0.045);
      material.transparent = true;
      material.depthWrite = false;
      material.transmission = 0;
      material.thickness = 0.08;
      material.clearcoat = 0.94;
      material.clearcoatRoughness = 0.17 + shellIndex * 0.025;
      material.iridescence = 0.72 + shellIndex * 0.055;
      material.iridescenceIOR = 1.22 + shellIndex * 0.04;
      material.iridescenceThicknessRange = [115 + shellIndex * 35, 410 + shellIndex * 55];
      material.emissive.setHex(shellEmissive[shellIndex]!);
      material.emissiveIntensity = 0.14;
      this.#shellMaterials.push(material);
      const shell = new Mesh(geometry, material);
      shell.name = `hero-c:alien-ribbon-shell-${shellIndex + 1}`;
      const rotation = shellRotations[shellIndex]!;
      shell.rotation.set(rotation[0], rotation[1], rotation[2]);
      const positions = geometry.getAttribute("position");
      const transformedVertex = new Vector3();
      for (let vertexIndex = 0; vertexIndex < positions.count; vertexIndex += 1) {
        transformedVertex.fromBufferAttribute(positions, vertexIndex).applyEuler(shell.rotation);
        minimumShipVertexRadius = Math.min(minimumShipVertexRadius, transformedVertex.length());
      }
      this.#alienRoot.add(shell);
    }
    this.#minimumShipVertexRadius = minimumShipVertexRadius;
    this.#ribbonBoundaryEdges = ribbonBoundaryEdges;
    this.#ribbonNonManifoldEdges = ribbonNonManifoldEdges;
    this.#ribbonDegenerateTriangles = ribbonDegenerateTriangles;
    this.#ribbonMaximumSeamPositionError = ribbonMaximumSeamPositionError;
    this.#ribbonMinimumSeamNormalDot = ribbonMinimumSeamNormalDot;
    this.#ribbonMaximumHolonomyCorrection = ribbonMaximumHolonomyCorrection;
    this.#alienRoot.position.set(1.7, 0.15, -1.8);
    this.#alienRoot.rotation.x = -0.08;

    const earthMaterial = this.#ownMaterial(physicalMaterial(0xffffff, 1, 0.48, 0.05));
    earthMaterial.vertexColors = true;
    earthMaterial.clearcoat = 0.62;
    earthMaterial.clearcoatRoughness = 0.28;
    earthMaterial.iridescence = 0.08;
    earthMaterial.iridescenceIOR = 1.24;
    earthMaterial.emissive.setHex(0x0c355c);
    earthMaterial.emissiveIntensity = 0.34;
    const earthGeometry = this.#ownGeometry(livingEarthGeometry(seed ^ 0x26c8_41b5));
    const earth = new Mesh(earthGeometry, earthMaterial);
    earth.name = "hero-c:living-earth-sphere";
    this.#earthRoot.add(earth);
    const earthAuraMaterial = this.#ownMaterial(additiveMaterial(0x78cfff, 0.17));
    const earthAura = new Mesh(this.#ownGeometry(new SphereGeometry(1.76, 24, 18)), earthAuraMaterial);
    earthAura.name = "hero-c:earth-atmosphere-aura";
    this.#earthRoot.add(earthAura);
    const earthCloudMaterial = this.#ownMaterial(additiveMaterial(0xe7f5f2, 0.065));
    const earthClouds = new Mesh(
      this.#ownGeometry(new SphereGeometry(1.64, 32, 22)),
      earthCloudMaterial,
    );
    earthClouds.name = "hero-c:earth-cloud-veil";
    earthClouds.scale.set(1, 0.985, 1);
    this.#earthRoot.add(earthClouds);
    this.#earthRoot.position.set(4.7, -1.2, -4.7);

    const twinkleGeometry = this.#ownGeometry(new IcosahedronGeometry(0.08, 1));
    const twinkleMaterial = this.#ownMaterial(additiveMaterial(0xffe8b8, 0.92));
    this.#twinkleMesh = new InstancedMesh(twinkleGeometry, twinkleMaterial, MAX_TWINKLES);
    this.#twinkleMesh.name = "hero-c:ordered-life-light-instances";
    this.#seedTwinkleInventory(seed);
    this.#twinkleRoot.add(this.#twinkleMesh);

    const protagonistEnvelope = this.#ownMaterial(physicalMaterial(0xa9e9e0, 0.62, 0.24, 0.08));
    protagonistEnvelope.clearcoat = 1;
    protagonistEnvelope.iridescence = 0.48;
    protagonistEnvelope.iridescenceIOR = 1.23;
    protagonistEnvelope.iridescenceThicknessRange = [105, 340];
    const protagonistCore = this.#ownMaterial(additiveMaterial(0xffe5a3, 0.98));
    const protagonistGeometry = this.#ownGeometry(livingDropletGeometry());
    const protagonist = new Mesh(protagonistGeometry, protagonistEnvelope);
    protagonist.name = "hero-c:protagonist-envelope";
    protagonist.scale.set(0.72, 1.1, 0.52);
    this.#protagonistRoot.add(protagonist);
    const core = new Mesh(this.#ownGeometry(new SphereGeometry(0.22, 16, 12)), protagonistCore);
    core.name = "hero-c:protagonist-core";
    core.position.z = 0.18;
    this.#protagonistRoot.add(core);
    const wingGeometry = this.#ownGeometry(new ConeGeometry(0.52, 1.28, 20, 1, true));
    this.#leftWing = new Mesh(wingGeometry, protagonistEnvelope);
    this.#leftWing.name = "hero-c:protagonist-left-wing";
    this.#leftWing.position.set(-0.58, 0.04, -0.04);
    this.#leftWing.rotation.set(0, 0, 1.18);
    this.#rightWing = new Mesh(wingGeometry, protagonistEnvelope);
    this.#rightWing.name = "hero-c:protagonist-right-wing";
    this.#rightWing.position.set(0.58, 0.04, -0.04);
    this.#rightWing.rotation.set(0, 0, -1.18);
    this.#protagonistRoot.add(this.#leftWing, this.#rightWing);
    this.#protagonistRoot.position.set(-3.25, -0.35, 0.3);

    const pulseMaterial = this.#ownMaterial(additiveMaterial(0x93f5db, 0.72));
    this.#pulseRing = new Mesh(this.#ownGeometry(new TorusGeometry(0.64, 0.035, 8, 64)), pulseMaterial);
    this.#pulseRing.name = "hero-c:answer-pulse-ring";
    this.#pulseRoot.add(this.#pulseRing);
    this.#pulseRoot.position.copy(this.#protagonistRoot.position);

    // Compile every reachable topology before the first story update hides it.
    this.#debrisRoot.visible = true;
    this.#nebulaRoot.visible = true;
    this.#previewRoot.visible = true;
    this.#alienRoot.visible = true;
    this.#twinkleRoot.visible = true;
    this.#earthRoot.visible = true;
    this.#protagonistRoot.visible = true;
    this.#pulseRoot.visible = true;
    this.#twinkleMesh.count = MAX_TWINKLES;
    this.#root.traverse((object) => {
      if ("isMesh" in object && object.isMesh === true) object.frustumCulled = false;
    });
    this.#initializedAllocations = this.#geometries.length + this.#materials.length;
  }

  initialize(context: FeatureInitContext): Promise<void> {
    void context;
    if (this.#state === "disposed" || this.#state === "disposing") {
      return Promise.reject(new Error("Cannot initialize a disposed space/Twinkle Hero feature."));
    }
    this.#state = "ready";
    return Promise.resolve();
  }

  update(frame: Readonly<JourneyRenderSnapshot>, clock: VisualClock): void {
    if (this.#state !== "ready") return;
    this.#storyTime = finiteStoryTime(frame.storyTime);
    this.#hasStoryUpdate = true;
    this.#shotId = frame.shotId;
    this.#debrisRoot.visible = this.#storyTime >= DEBRIS_START_SECONDS
      && this.#storyTime < DEBRIS_END_SECONDS;
    this.#nebulaRoot.visible = this.#storyTime >= NEBULA_START_SECONDS;
    this.#previewRoot.visible = this.#storyTime >= PREVIEW_START_SECONDS
      && this.#storyTime < SHIP_REVEAL_SECONDS;
    this.#alienRoot.visible = this.#storyTime >= SHIP_REVEAL_SECONDS;
    this.#earthRoot.visible = this.#storyTime >= TWINKLE_START_SECONDS;
    this.#twinkleRoot.visible = this.#storyTime >= TWINKLE_START_SECONDS;
    this.#protagonistRoot.visible = this.#storyTime >= DEBRIS_START_SECONDS;
    this.#pulseRoot.visible = this.#storyTime >= ANSWER_WINDOW_SECONDS
      && this.#storyTime < TWINKLE_START_SECONDS;

    this.#twinkleStage = this.#stageFor(this.#storyTime);
    this.#twinkleSourceCount = frame.pulses.length;
    this.#ledgerOrderPreserved = true;
    let previousId = 0;
    for (let index = 0; index < frame.pulses.length; index += 1) {
      const pulse = frame.pulses[index]!;
      if (pulse.id <= previousId) this.#ledgerOrderPreserved = false;
      previousId = pulse.id;
    }
    this.#answerReceived = frame.answerAt !== null
      || frame.pulses.some((pulse) => pulse.phase === "ANSWER" && pulse.journeyTime >= 166);

    const time = clock.elapsedSeconds;
    this.#nebulaRoot.rotation.z = Math.sin(time * 0.035) * 0.018;
    this.#previewRoot.rotation.z = Math.sin(time * 0.19) * 0.08;
    this.#alienRoot.rotation.y = Math.sin(time * 0.12) * 0.08;
    this.#alienRoot.rotation.z = Math.sin(time * 0.08) * 0.035;
    this.#earthRoot.rotation.y = time * 0.018;
    this.#protagonistRoot.position.y = -0.35 + Math.sin(time * 0.72) * 0.12;
    this.#pulseRoot.position.y = this.#protagonistRoot.position.y;
    const wingOpen = this.#storyTime >= TWINKLE_START_SECONDS;
    this.#leftWing.rotation.z = wingOpen ? 1.72 : 1.18;
    this.#rightWing.rotation.z = wingOpen ? -1.72 : -1.18;

    const beaconEnvelope = this.#storyTime >= 140 && this.#storyTime < 143
      ? Math.sin(((this.#storyTime - 140) / 3) * Math.PI)
      : 0;
    this.#beaconLight.intensity = Math.max(0, beaconEnvelope) * 2.4;
    const responseVisible = this.#storyTime >= ANSWER_WINDOW_SECONDS
      && this.#storyTime < TWINKLE_START_SECONDS;
    const responseEnergy = responseVisible
      ? (this.#answerReceived ? 1.05 + Math.sin(time * 2.4) * 0.2 : 0.46)
      : (this.#alienRoot.visible ? 0.52 : 0);
    this.#alienLight.intensity = responseEnergy * 1.22;
    this.#earthLight.intensity = this.#earthRoot.visible ? 2.2 : 0;
    for (let index = 0; index < this.#shellMaterials.length; index += 1) {
      this.#shellMaterials[index]!.emissiveIntensity = 0.14 + responseEnergy * 0.16
        + Math.sin(time * 0.8 + index * 1.8) * 0.025;
    }
    const pulseCycle = (time * 0.38) % 1;
    this.#pulseRing.scale.setScalar(0.7 + pulseCycle * 3.1);
    this.#pulseRing.rotation.z = time * 0.08;

    if (this.#twinkleRoot.visible) this.#positionTwinkles(frame);
    this.#applyDensity();
    this.#cameraForStory();

    const solitudeMix = Math.max(0, Math.min(1, (this.#storyTime - 148) / 13));
    const returnMix = Math.max(0, Math.min(1, (this.#storyTime - 171) / 7));
    this.#backgroundColor.setRGB(
      0.012 + solitudeMix * 0.015 + returnMix * 0.015,
      0.015 + solitudeMix * 0.008 + returnMix * 0.025,
      0.04 + solitudeMix * 0.025 + returnMix * 0.035,
    );
    this.#spaceFog.color.copy(this.#backgroundColor);
    this.#spaceFog.density = 0.006 - returnMix * 0.0015;
  }

  render(recorder: RenderPassRecorder): void {
    void recorder;
    // The pooled world feature owns the single persistent scene pass.
  }

  quality(profile: Readonly<RenderQualityProfile>): void {
    if (this.#state === "disposed" || this.#state === "disposing") return;
    this.#qualityTier = profile.tier;
    if (this.#hasStoryUpdate) this.#applyDensity();
  }

  resize(viewport: Readonly<RenderViewport>): void {
    if (this.#state === "disposed" || this.#state === "disposing") return;
    this.#camera.aspect = viewport.width / viewport.height;
    this.#camera.updateProjectionMatrix();
  }

  invalidateHistory(event: Readonly<RenderHistoryInvalidation>): void {
    void event;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    this.#state = "disposing";
    const attempt = Promise.resolve().then(() => {
      const failures: unknown[] = [];
      this.#scene.remove(this.#root, this.#ambient, this.#hemisphere, this.#keyLight);
      this.#root.clear();
      for (const owned of this.#geometries) {
        if (owned.disposed) continue;
        try {
          owned.geometry.dispose();
          owned.disposed = true;
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      for (const owned of this.#materials) {
        if (owned.disposed) continue;
        try {
          owned.material.dispose();
          owned.disposed = true;
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        this.#state = "failed";
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Space/Twinkle Hero feature cleanup failed.");
      }
      this.#scene.background = this.#originalBackground;
      this.#scene.fog = this.#originalFog;
      this.#state = "disposed";
    });
    const settled = attempt.catch((error: unknown) => {
      this.#disposePromise = null;
      throw error;
    });
    this.#disposePromise = settled;
    return settled;
  }

  snapshot(): Readonly<SpaceTwinkleHeroFeatureSnapshot> {
    const alienVisible = this.#alienRoot.visible;
    const previewVisible = this.#previewRoot.visible;
    const responseVisible = this.#storyTime >= ANSWER_WINDOW_SECONDS
      && this.#storyTime < TWINKLE_START_SECONDS
      && this.#answerReceived;
    return freezeSnapshot({
      state: this.#state,
      storyTime: this.#storyTime,
      shotId: this.#shotId,
      qualityTier: this.#qualityTier,
      humanDebrisVisible: this.#debrisRoot.visible,
      humanDebrisForms: HUMAN_DEBRIS_FORMS,
      humanGrammarRectilinear: true,
      solarPanels: 1,
      straightTrusses: 1,
      habitatModules: 1,
      slabRadiators: 1,
      rectangularAirlocks: 1,
      brokenObservationFrames: 1,
      emptyCockpits: 1,
      amberBeaconVisible: this.#beaconLight.intensity > 0,
      machineReactivated: false,
      nebulaVisible: this.#nebulaRoot.visible,
      darkNegativeSpaceClear: true,
      peripheralArcsVisible: previewVisible,
      peripheralArcCount: previewVisible ? this.#previewArcs.length : 0,
      peripheralArcsIncomplete: previewVisible,
      unknownShipVisible: alienVisible,
      alienRibbonShellCount: alienVisible ? ALIEN_SHELL_COUNT : 0,
      alienRibbonInventory: ALIEN_SHELL_COUNT,
      closedBsplineShells: this.#ribbonBoundaryEdges === 0
        && this.#ribbonNonManifoldEdges === 0
        && this.#ribbonDegenerateTriangles === 0
        && this.#ribbonMaximumSeamPositionError <= 1e-6,
      parallelTransportFrames: this.#ribbonMinimumSeamNormalDot >= 0.999_99
        && Number.isFinite(this.#ribbonMaximumHolonomyCorrection),
      constrainedSuperformulaSections: true,
      ribbonThickness: ALIEN_RIBBON_THICKNESS,
      centralVoidOpen: alienVisible && this.#minimumShipVertexRadius > 1.5,
      minimumShipVertexRadius: this.#minimumShipVertexRadius,
      ribbonTopologyManifold: this.#ribbonBoundaryEdges === 0
        && this.#ribbonNonManifoldEdges === 0
        && this.#ribbonDegenerateTriangles === 0,
      ribbonBoundaryEdges: this.#ribbonBoundaryEdges,
      ribbonNonManifoldEdges: this.#ribbonNonManifoldEdges,
      ribbonDegenerateTriangles: this.#ribbonDegenerateTriangles,
      ribbonMaximumSeamPositionError: this.#ribbonMaximumSeamPositionError,
      ribbonMinimumSeamNormalDot: this.#ribbonMinimumSeamNormalDot,
      ribbonMaximumHolonomyCorrection: this.#ribbonMaximumHolonomyCorrection,
      alienUsesHumanGrammar: false,
      alienHasCockpitWindowThrusterOrFront: false,
      responseWindowOpen: this.#storyTime >= ANSWER_WINDOW_SECONDS
        && this.#storyTime < TWINKLE_START_SECONDS,
      answerReceived: this.#answerReceived,
      alienResponseVisible: responseVisible,
      protagonistVisible: this.#protagonistRoot.visible,
      protagonistWingsOpen: this.#storyTime >= TWINKLE_START_SECONDS,
      earthVisible: this.#earthRoot.visible,
      twinkleStage: this.#twinkleStage,
      visibleTwinkles: this.#twinkleRoot.visible ? this.#twinkleMesh.count : 0,
      twinkleSourceCount: this.#twinkleSourceCount,
      ledgerOrderPreserved: this.#ledgerOrderPreserved,
      finalLifeLightsTemporalStable: true,
      formalTitleVisible: this.#storyTime >= FINAL_TITLE_SECONDS,
      visibleDistantStars: this.#distantStars.count,
      ownedGeometries: this.#geometries.filter((entry) => !entry.disposed).length,
      ownedMaterials: this.#materials.filter((entry) => !entry.disposed).length,
      ownedTextures: 0,
      ownedObjects: this.#ownedObjectCount(),
      allocationsAfterInitialize:
        this.#geometries.length + this.#materials.length - this.#initializedAllocations,
    });
  }

  #ownMaterial<T extends Material>(material: T): T {
    material.name = `hero-c:${this.#materials.length}:${material.type}`;
    this.#materials.push({ material, disposed: false });
    return material;
  }

  #ownGeometry<T extends BufferGeometry>(geometry: T): T {
    geometry.name = `hero-c:${this.#geometries.length}:${geometry.type}`;
    this.#geometries.push({ geometry, disposed: false });
    return geometry;
  }

  #addBox(
    parent: Group,
    geometry: BufferGeometry,
    material: Material,
    name: string,
    position: readonly [number, number, number],
    scale: readonly [number, number, number],
    rotation: readonly [number, number, number] = [0, 0, 0],
  ): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    parent.add(mesh);
    return mesh;
  }

  #buildHumanDebris(
    box: BufferGeometry,
    panel: BufferGeometry,
    metal: Material,
    solar: Material,
    amber: Material,
    interior: Material,
  ): void {
    const solarPanel = new Group();
    solarPanel.name = "hero-c:debris-form-1-square-solar-panel";
    solarPanel.position.set(-4.8, 1.8, -2.2);
    solarPanel.rotation.set(-0.24, 0.36, 0.13);
    for (let row = -1; row <= 1; row += 1) {
      for (let column = -1; column <= 1; column += 1) {
        const cell = new Mesh(panel, solar);
        cell.name = `hero-c:solar-cell-${row + 1}-${column + 1}`;
        cell.position.set(column * 0.62, row * 0.5, 0);
        cell.scale.set(0.54, 0.42, 1);
        solarPanel.add(cell);
      }
    }
    this.#addBox(solarPanel, box, metal, "hero-c:solar-panel-straight-spine", [0, 0, -0.04], [0.07, 1.72, 0.07]);
    this.#debrisRoot.add(solarPanel);

    const truss = new Group();
    truss.name = "hero-c:debris-form-2-straight-truss";
    truss.position.set(-2.4, -2.05, -3.4);
    truss.rotation.set(0.12, -0.42, 0.28);
    this.#addBox(truss, box, metal, "hero-c:truss-top", [0, 0.28, 0], [2.4, 0.06, 0.08]);
    this.#addBox(truss, box, metal, "hero-c:truss-bottom", [0, -0.28, 0], [2.4, 0.06, 0.08]);
    for (let index = -2; index <= 2; index += 1) {
      this.#addBox(truss, box, metal, `hero-c:truss-upright-${index + 2}`, [index * 0.55, 0, 0], [0.05, 0.58, 0.06]);
    }
    this.#debrisRoot.add(truss);

    const habitat = new Group();
    habitat.name = "hero-c:debris-form-3-box-habitat-module";
    habitat.position.set(2.6, 2.15, -4.8);
    habitat.rotation.set(0.22, 0.31, -0.17);
    this.#addBox(habitat, box, metal, "hero-c:habitat-box", [0, 0, 0], [2.1, 1.18, 0.92]);
    this.#addBox(habitat, box, interior, "hero-c:habitat-empty-port", [0, 0, 0.48], [0.72, 0.54, 0.04]);
    this.#addBox(habitat, box, amber, "hero-c:habitat-amber-line", [0, -0.48, 0.51], [1.42, 0.045, 0.04]);
    this.#debrisRoot.add(habitat);

    const radiator = new Group();
    radiator.name = "hero-c:debris-form-4-slab-radiator";
    radiator.position.set(5.1, -2.2, -5.7);
    radiator.rotation.set(-0.15, -0.52, 0.18);
    for (let index = -2; index <= 2; index += 1) {
      this.#addBox(radiator, box, metal, `hero-c:radiator-slab-${index + 2}`, [index * 0.31, 0, 0], [0.24, 1.65, 0.07]);
    }
    this.#debrisRoot.add(radiator);

    const airlock = new Group();
    airlock.name = "hero-c:debris-form-5-rectangular-airlock";
    airlock.position.set(-5.4, -0.15, -5.6);
    airlock.rotation.set(0.1, 0.28, -0.08);
    this.#addBox(airlock, box, metal, "hero-c:airlock-left", [-0.72, 0, 0], [0.16, 1.72, 0.24]);
    this.#addBox(airlock, box, metal, "hero-c:airlock-right", [0.72, 0, 0], [0.16, 1.72, 0.24]);
    this.#addBox(airlock, box, metal, "hero-c:airlock-top", [0, 0.78, 0], [1.58, 0.16, 0.24]);
    this.#addBox(airlock, box, metal, "hero-c:airlock-bottom", [0, -0.78, 0], [1.58, 0.16, 0.24]);
    this.#debrisRoot.add(airlock);

    const observation = new Group();
    observation.name = "hero-c:debris-form-6-broken-square-observation-frame";
    observation.position.set(0.1, 2.75, -6.2);
    observation.rotation.set(0.18, -0.14, 0.09);
    this.#addBox(observation, box, metal, "hero-c:observation-left", [-0.9, 0, 0], [0.13, 2.05, 0.18]);
    this.#addBox(observation, box, metal, "hero-c:observation-top", [0, 0.96, 0], [1.92, 0.13, 0.18]);
    this.#addBox(observation, box, metal, "hero-c:observation-right-broken", [0.9, 0.4, 0], [0.13, 1.12, 0.18]);
    this.#debrisRoot.add(observation);

    const cockpit = new Group();
    cockpit.name = "hero-c:debris-form-7-box-empty-cockpit";
    cockpit.position.set(3.25, -0.35, -1.8);
    cockpit.rotation.set(-0.12, 0.2, 0.08);
    this.#addBox(cockpit, box, metal, "hero-c:cockpit-shell", [0, 0, 0], [2.25, 1.48, 1.12]);
    this.#addBox(cockpit, box, interior, "hero-c:cockpit-empty-interior", [0, 0.08, 0.59], [1.5, 0.88, 0.05]);
    this.#addBox(cockpit, box, metal, "hero-c:cockpit-empty-seat", [0, -0.32, 0.68], [0.56, 0.42, 0.16]);
    this.#addBox(cockpit, box, amber, "hero-c:cockpit-dying-amber-strip", [0, -0.58, 0.61], [1.36, 0.04, 0.04]);
    this.#beaconLight.position.set(3.25, -0.9, -1.1);
    this.#debrisRoot.add(cockpit);
  }

  #buildNebula(seed: number): void {
    const colors = [0x8a4fbe, 0x39b7ad, 0xe36e83, 0xe2ad4f] as const;
    const positions = [
      [-7.8, 3.3, -8.5],
      [7.6, 3.8, -9.2],
      [-8.3, -4.1, -7.4],
      [8.7, -3.7, -8.8],
    ] as const;
    const geometries = [
      this.#ownGeometry(nebulaLobeGeometry(seed ^ 0x1f82_a6c3)),
      this.#ownGeometry(nebulaLobeGeometry(seed ^ 0x6c17_39de)),
    ] as const;
    for (let index = 0; index < colors.length; index += 1) {
      const cluster = new Group();
      cluster.name = `hero-c:peripheral-nebula-${index + 1}`;
      const position = positions[index]!;
      cluster.position.set(position[0], position[1], position[2]);
      cluster.rotation.set(index * 0.08, index * 0.11, index * 0.16);
      const coreMaterial = this.#ownMaterial(additiveMaterial(colors[index]!, 0.03));
      const haloMaterial = this.#ownMaterial(additiveMaterial(colors[index]!, 0.009));
      for (let lobeIndex = 0; lobeIndex < 4; lobeIndex += 1) {
        const angle = (lobeIndex / 4) * TAU
          + hashedUnit(index, lobeIndex, seed ^ 0xc72b_491d) * 0.64;
        const radius = 0.45 + hashedUnit(index, lobeIndex, seed ^ 0x39ad_6107) * 0.85;
        const scaleX = 2.25 + hashedUnit(index, lobeIndex, seed ^ 0x9d42_18f5) * 1.05;
        const scaleY = 1.25 + hashedUnit(index, lobeIndex, seed ^ 0x4b61_e82a) * 0.88;
        const scaleZ = 0.62 + hashedUnit(index, lobeIndex, seed ^ 0xe73c_2904) * 0.48;
        const geometry = geometries[(index + lobeIndex) % geometries.length]!;
        const lobe = new Mesh(geometry, coreMaterial);
        lobe.name = `hero-c:peripheral-nebula-${index + 1}-lobe-${lobeIndex + 1}`;
        lobe.position.set(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius * 0.72,
          (hashedUnit(index, lobeIndex, seed ^ 0x72a6_d30b) - 0.5) * 0.7,
        );
        lobe.rotation.set(angle * 0.13, angle * 0.2, angle + index * 0.28);
        lobe.scale.set(scaleX, scaleY, scaleZ);

        const halo = new Mesh(geometry, haloMaterial);
        halo.name = `hero-c:peripheral-nebula-${index + 1}-halo-${lobeIndex + 1}`;
        halo.position.copy(lobe.position);
        halo.rotation.copy(lobe.rotation);
        halo.scale.set(scaleX * 1.28, scaleY * 1.3, scaleZ * 1.36);
        cluster.add(halo, lobe);
      }
      this.#nebulaRoot.add(cluster);
    }
  }

  #buildPreviewArcs(): void {
    const colors = [0x5ed9d0, 0xe47a8b, 0xe8b066] as const;
    for (let index = 0; index < ALIEN_SHELL_COUNT; index += 1) {
      const geometry = this.#ownGeometry(new TorusGeometry(
        2.85 + index * 0.18,
        0.035 + index * 0.006,
        7,
        68,
        1.65 + index * 0.12,
      ));
      const material = this.#ownMaterial(additiveMaterial(colors[index]!, 0.24));
      const arc = new Mesh(geometry, material);
      arc.name = `hero-c:s20-incomplete-peripheral-arc-${index + 1}`;
      arc.position.set(1.7, 0.15, -1.8);
      arc.rotation.set(0.12 + index * 0.34, -0.18 + index * 0.26, -1.2 + index * 1.9);
      this.#previewArcs.push(arc);
      this.#previewRoot.add(arc);
    }
  }

  #seedTwinkleInventory(seed: number): void {
    for (let index = 0; index < MAX_TWINKLES; index += 1) {
      const mixed = mix32(seed ^ Math.imul(index + 1, 0x9e37_79b9));
      const angle = -2.5 + index * 0.19 + ((mixed & 255) / 255) * 0.16;
      const radius = 1.8 + (index / MAX_TWINKLES) * 7.3;
      this.#twinkleDummy.position.set(
        4.7 + Math.cos(angle) * radius,
        -1.2 + Math.sin(angle * 1.31) * radius * 0.46,
        -4.2 + Math.sin(angle * 0.77) * 1.4,
      );
      const scale = 0.45 + ((mixed >>> 8) & 255) / 255 * 0.9;
      this.#twinkleDummy.scale.setScalar(scale);
      this.#twinkleDummy.rotation.set(angle * 0.2, angle * 0.13, angle);
      this.#twinkleDummy.updateMatrix();
      this.#twinkleMesh.setMatrixAt(index, this.#twinkleDummy.matrix);
      this.#twinkleMesh.setColorAt(index, this.#twinkleColors[index % this.#twinkleColors.length]!);
    }
    this.#twinkleMesh.instanceMatrix.needsUpdate = true;
    if (this.#twinkleMesh.instanceColor) this.#twinkleMesh.instanceColor.needsUpdate = true;
  }

  #positionTwinkles(frame: Readonly<JourneyRenderSnapshot>): void {
    const pulses = frame.pulses;
    if (pulses.length === 0) return;
    for (let index = 0; index < MAX_TWINKLES; index += 1) {
      const pulse = pulses[index % pulses.length]!;
      const mixed = mix32(pulse.value ^ Math.imul(index + 1, 0x85eb_ca6b));
      const angle = -2.45
        + index * 0.19
        + ((mixed & 511) / 511 - 0.5) * 0.22
        + pulse.id * 0.06;
      const progress = index / MAX_TWINKLES;
      const radius = 1.75 + progress * 7.5 + ((mixed >>> 10) & 31) / 31 * 0.45;
      this.#twinkleDummy.position.set(
        4.7 + Math.cos(angle) * radius + pulse.x * 0.34,
        -1.2 + Math.sin(angle * 1.31) * radius * 0.46 + pulse.y * 0.26,
        -4.2 + Math.sin(angle * 0.77 + pulse.id) * 1.45,
      );
      const scale = 0.44 + ((mixed >>> 15) & 255) / 255 * 0.95;
      this.#twinkleDummy.scale.setScalar(scale);
      this.#twinkleDummy.rotation.set(angle * 0.2, angle * 0.13, angle);
      this.#twinkleDummy.updateMatrix();
      this.#twinkleMesh.setMatrixAt(index, this.#twinkleDummy.matrix);
      this.#twinkleMesh.setColorAt(
        index,
        this.#twinkleColors[(pulse.id + index) % this.#twinkleColors.length]!,
      );
    }
    this.#twinkleMesh.instanceMatrix.needsUpdate = true;
    if (this.#twinkleMesh.instanceColor) this.#twinkleMesh.instanceColor.needsUpdate = true;
  }

  #stageFor(storyTime: number): TwinkleStage {
    if (storyTime < TWINKLE_START_SECONDS) return "none";
    if (storyTime < 172.2) return "one";
    if (storyTime < 174) return "few";
    if (storyTime < 176) return "tens";
    return "many";
  }

  #applyDensity(): void {
    const highCounts: Readonly<Record<TwinkleStage, number>> = Object.freeze({
      none: 0,
      one: 1,
      few: 8,
      tens: 40,
      many: MAX_TWINKLES,
    });
    const caps = this.#qualityTier === "high"
      ? Object.freeze({ one: 1, few: 8, tens: 40, many: MAX_TWINKLES })
      : this.#qualityTier === "balanced"
        ? Object.freeze({ one: 1, few: 6, tens: 28, many: 112 })
        : Object.freeze({ one: 1, few: 4, tens: 16, many: 64 });
    this.#twinkleMesh.count = this.#twinkleStage === "none"
      ? 0
      : Math.min(highCounts[this.#twinkleStage], caps[this.#twinkleStage]);
    this.#distantStars.count = this.#qualityTier === "high"
      ? 180
      : this.#qualityTier === "balanced"
        ? 128
        : 72;
  }

  #cameraForStory(): void {
    if (this.#storyTime < PREVIEW_START_SECONDS) {
      this.#camera.position.set(0.3, 0.45, 14.8);
    } else if (this.#storyTime < SHIP_REVEAL_SECONDS) {
      this.#camera.position.set(-0.25, 0.28, 15.2);
    } else if (this.#storyTime < TWINKLE_START_SECONDS) {
      this.#camera.position.set(-0.2, 0.35, 14.6);
    } else {
      this.#camera.position.set(0.15, 0.52, 16.2);
    }
    const focusX = this.#storyTime < SHIP_REVEAL_SECONDS ? 0.4 : 1.15;
    this.#camera.lookAt(focusX, 0.02, -1.9);
  }

  #ownedObjectCount(): number {
    let count = 0;
    this.#root.traverse(() => {
      count += 1;
    });
    return count + 3;
  }
}
