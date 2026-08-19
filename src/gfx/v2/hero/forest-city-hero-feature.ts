import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
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
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  type Material,
  type Texture,
} from "three/webgpu";
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

const CITY_REVEAL_SECONDS = 62;
const DEFAULT_MARKER_SECONDS = 58;
const CITY_END_SECONDS = 88;
const TAU = Math.PI * 2;
const SAFE_CORRIDOR_HALF_WIDTH = 2.8;

type HeroLifecycle = "new" | "ready" | "disposing" | "disposed" | "failed";

interface HeroOwnedMaterial {
  readonly material: Material;
  disposed: boolean;
}

interface HeroOwnedGeometry {
  readonly geometry: BufferGeometry;
  disposed: boolean;
}

interface HeroOwnedTexture {
  readonly texture: Texture;
  disposed: boolean;
}

interface DeterministicRandom {
  next(): number;
  range(minimum: number, maximum: number): number;
}

export interface ForestCityHeroFeatureSnapshot {
  readonly state: HeroLifecycle;
  readonly storyTime: number;
  readonly shotId: string;
  readonly qualityTier: RenderQualityProfile["tier"];
  readonly forestPeakVisible: boolean;
  readonly cityRuinsVisible: boolean;
  readonly riverVisible: boolean;
  readonly waterfallVisible: boolean;
  readonly protagonistVisible: boolean;
  readonly pulseTargetVisible: boolean;
  readonly flowGuideVisible: boolean;
  readonly natureReadsFirst: boolean;
  readonly safeCorridorClear: boolean;
  readonly safeCorridorHalfWidth: number;
  readonly storySightlineOpen: boolean;
  readonly hydrologyConnected: boolean;
  readonly foliageTemporalStable: boolean;
  readonly visibleTrees: number;
  readonly visibleGrassClusters: number;
  readonly visibleFlowers: number;
  readonly visibleBirds: number;
  readonly visibleMistClusters: number;
  readonly visibleClouds: number;
  readonly ruinTowers: number;
  readonly floorSlabs: number;
  readonly columnGridSegments: number;
  readonly facadeCells: number;
  readonly emptyBenchSeats: number;
  readonly playgroundFrames: number;
  readonly observationFrames: number;
  readonly amberBeacons: number;
  readonly rooftopTrees: number;
  readonly windowBirds: number;
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

function hashedUnit(x: number, y: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x85eb_ca6b) ^ Math.imul(y + seed, 0xc2b2_ae35);
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d);
  value = Math.imul(value ^ (value >>> 15), 0x846c_a68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function periodicNoise(x: number, y: number, size: number, cells: number, seed: number): number {
  const scaledX = (x / size) * cells;
  const scaledY = (y / size) * cells;
  const x0 = Math.floor(scaledX);
  const y0 = Math.floor(scaledY);
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const tx = scaledX - x0;
  const ty = scaledY - y0;
  const smoothX = tx * tx * (3 - 2 * tx);
  const smoothY = ty * ty * (3 - 2 * ty);
  const top = hashedUnit(x0 % cells, y0 % cells, seed)
    + (hashedUnit(x1, y0 % cells, seed) - hashedUnit(x0 % cells, y0 % cells, seed)) * smoothX;
  const bottom = hashedUnit(x0 % cells, y1, seed)
    + (hashedUnit(x1, y1, seed) - hashedUnit(x0 % cells, y1, seed)) * smoothX;
  return top + (bottom - top) * smoothY;
}

function proceduralTexture(
  seed: number,
  low: number,
  high: number,
  repeatX: number,
  repeatY: number,
): DataTexture {
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  const lowChannels = [(low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff] as const;
  const highChannels = [(high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff] as const;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const macro = periodicNoise(x, y, size, 6, seed);
      const meso = periodicNoise(x, y, size, 19, seed ^ 0x51ed_270b);
      const grain = hashedUnit(x, y, seed ^ 0x75d9_3cbb);
      const blend = Math.max(0, Math.min(1, macro * 0.62 + meso * 0.28 + grain * 0.1));
      const offset = (y * size + x) * 4;
      data[offset] = Math.round(lowChannels[0] + (highChannels[0] - lowChannels[0]) * blend);
      data[offset + 1] = Math.round(lowChannels[1] + (highChannels[1] - lowChannels[1]) * blend);
      data[offset + 2] = Math.round(lowChannels[2] + (highChannels[2] - lowChannels[2]) * blend);
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function standardMaterial(color: number, roughness: number, metalness = 0): MeshStandardNodeMaterial {
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
  ior: number,
): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial();
  material.color.setHex(color);
  material.roughness = roughness;
  material.ior = ior;
  material.transparent = opacity < 1;
  material.opacity = opacity;
  material.depthWrite = opacity >= 0.92;
  material.side = DoubleSide;
  material.toneMapped = true;
  material.transmission = 0;
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

function finiteStoryTime(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MARKER_SECONDS;
  return Math.max(0, Math.min(180, value));
}

function riverCenter(z: number): number {
  return Math.sin(z * 0.16) * 0.82 + Math.sin(z * 0.052) * 0.44;
}

function terrainHeight(x: number, z: number, seed: number): number {
  const ridge = Math.sin(x * 0.27 + (seed & 31) * 0.03) * 0.34
    + Math.cos(z * 0.19 - (seed & 15) * 0.04) * 0.28
    + Math.sin((x + z) * 0.11) * 0.22;
  const distance = Math.abs(x - riverCenter(z));
  const riverCut = Math.max(0, 1 - distance / 3.6) * 0.82;
  return ridge - riverCut;
}

function organicRockGeometry(seed: number): IcosahedronGeometry {
  const geometry = new IcosahedronGeometry(1, 2);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const latitude = Math.round((y + 1.5) * 4_096);
    const longitude = Math.round((Math.atan2(z, x) + Math.PI) * 2_048);
    const variation = 0.82 + hashedUnit(latitude, longitude, seed) * 0.3;
    positions.setXYZ(index, x * variation, y * variation * 0.76, z * variation);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function grassTuftGeometry(): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let blade = 0; blade < 3; blade += 1) {
    const angle = (blade / 3) * Math.PI;
    const sideX = Math.cos(angle) * 0.13;
    const sideZ = Math.sin(angle) * 0.13;
    const leanX = Math.sin(angle + 0.7) * 0.12;
    const leanZ = Math.cos(angle + 0.7) * 0.12;
    positions.push(
      -sideX, 0, -sideZ,
      sideX, 0, sideZ,
      leanX, 0.82 + blade * 0.08, leanZ,
    );
    uvs.push(0, 0, 1, 0, 0.5, 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

function flyingBirdGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([
    0, 0, 0,
    -0.62, 0.22, 0,
    -0.12, -0.06, 0,
    0, 0, 0,
    0.62, 0.22, 0,
    0.12, -0.06, 0,
    -0.12, -0.06, 0,
    0.12, -0.06, 0,
    0, -0.42, 0,
  ], 3));
  geometry.computeVertexNormals();
  return geometry;
}

function sunsetSkyGeometry(): SphereGeometry {
  const radius = 48;
  const geometry = new SphereGeometry(radius, 32, 20);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const low = new Color(0xc75e42);
  const horizon = new Color(0xf0a66f);
  const high = new Color(0x3d4967);
  const current = new Color();
  for (let index = 0; index < positions.count; index += 1) {
    const height = Math.max(0, Math.min(1, (positions.getY(index) / radius + 1) * 0.5));
    if (height < 0.53) current.copy(low).lerp(horizon, height / 0.53);
    else current.copy(horizon).lerp(high, (height - 0.53) / 0.47);
    colors[index * 3] = current.r;
    colors[index * 3 + 1] = current.g;
    colors[index * 3 + 2] = current.b;
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

function livingDropletGeometry(): SphereGeometry {
  const radius = 0.82;
  const geometry = new SphereGeometry(radius, 24, 18);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const normalizedY = y / radius;
    const lowerTaper = normalizedY < -0.08
      ? Math.max(0.42, 1 + (normalizedY + 0.08) * 0.56)
      : 1;
    positions.setXYZ(
      index,
      x * lowerTaper * (1 + Math.sin(normalizedY * 4.8) * 0.035),
      y + (1 - Math.abs(normalizedY)) * 0.045,
      z * lowerTaper,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function freezeSnapshot(
  input: ForestCityHeroFeatureSnapshot,
): Readonly<ForestCityHeroFeatureSnapshot> {
  return Object.freeze({ ...input });
}

/**
 * Preallocated R2-G4 forest/city realization. The canonical WorldPlan and
 * streamed chunk lifecycle remain authoritative; this feature owns only the
 * visual Hero graph and never allocates resources from update/quality/render.
 */
export class ForestCityHeroFeature implements RenderFeature {
  readonly id = "hero-slice-b-forest-city";
  readonly #scene: Scene;
  readonly #camera: PerspectiveCamera;
  readonly #root = new Group();
  readonly #forestRoot = new Group();
  readonly #cityRoot = new Group();
  readonly #waterRoot = new Group();
  readonly #waterfallRoot = new Group();
  readonly #flowRoot = new Group();
  readonly #pulseRoot = new Group();
  readonly #protagonistRoot = new Group();
  readonly #skyRoot = new Group();
  readonly #treeTrunks: InstancedMesh;
  readonly #treeCrowns: InstancedMesh;
  readonly #treeCrownLobes: readonly InstancedMesh[];
  readonly #treeBranches: InstancedMesh;
  readonly #grass: InstancedMesh;
  readonly #flowers: InstancedMesh;
  readonly #birds: InstancedMesh;
  readonly #mist: InstancedMesh;
  readonly #clouds: InstancedMesh;
  readonly #cloudLobes: readonly InstancedMesh[];
  readonly #riverTexture: Texture;
  readonly #pulseRing: Mesh;
  readonly #materials: HeroOwnedMaterial[] = [];
  readonly #geometries: HeroOwnedGeometry[] = [];
  readonly #textures: HeroOwnedTexture[] = [];
  readonly #originalBackground: Scene["background"];
  readonly #originalFog: Scene["fog"];
  readonly #backgroundColor = new Color(0xd9855e);
  readonly #aerialFog = new FogExp2(0xbc7659, 0.015);
  readonly #ambient: AmbientLight;
  readonly #hemisphere: HemisphereLight;
  readonly #sun: DirectionalLight;
  readonly #coreLight: PointLight;
  readonly #amberLight: PointLight;
  #state: HeroLifecycle = "new";
  #storyTime = DEFAULT_MARKER_SECONDS;
  #shotId = "S09";
  #qualityTier: RenderQualityProfile["tier"] = "high";
  #initializedAllocations = 0;
  #disposePromise: Promise<void> | null = null;
  #ruinTowers = 0;
  #floorSlabs = 0;
  #columnGridSegments = 0;
  #facadeCells = 0;
  #emptyBenchSeats = 0;
  #playgroundFrames = 0;
  #observationFrames = 0;
  #amberBeacons = 0;
  #rooftopTrees = 0;
  #windowBirds = 0;
  #safeCorridorClear = true;

  constructor(scene: Scene, camera: PerspectiveCamera, plan: Readonly<WorldPlan>) {
    this.#scene = scene;
    this.#camera = camera;
    this.#originalBackground = scene.background;
    this.#originalFog = scene.fog;
    scene.background = this.#backgroundColor;
    scene.fog = this.#aerialFog;

    const forestChunk = plan.chunks.find((chunk) => chunk.id === "S09");
    const seed = forestChunk?.environment.flora.seedFingerprint ?? Number(plan.worldSeed);
    const random = randomFrom(seed);
    const groundTexture = this.#ownTexture(proceduralTexture(
      seed ^ 0x28a7_0afd,
      0x30432d,
      0x8a7750,
      7,
      9,
    ));
    groundTexture.name = "hero-b:forest-ground-texture";
    const concreteTexture = this.#ownTexture(proceduralTexture(
      seed ^ 0x9e37_79b9,
      0x303236,
      0x83817a,
      5,
      5,
    ));
    concreteTexture.name = "hero-b:weathered-concrete-texture";
    const riverTexture = this.#riverTexture = this.#ownTexture(proceduralTexture(
      seed ^ 0x75d9_3cbb,
      0x1d6670,
      0x8fd5c3,
      3,
      12,
    ));
    riverTexture.name = "hero-b:river-flow-texture";
    const foliageTexture = this.#ownTexture(proceduralTexture(
      seed ^ 0x4c91_b36d,
      0x173d25,
      0x91ad63,
      9,
      11,
    ));
    foliageTexture.name = "hero-b:foliage-surface-texture";

    this.#root.name = "hero-b:forest-city-root";
    this.#forestRoot.name = "hero-b:forest-world";
    this.#cityRoot.name = "hero-b:rectilinear-city";
    this.#waterRoot.name = "hero-b:river";
    this.#waterfallRoot.name = "hero-b:waterfall";
    this.#flowRoot.name = "hero-b:flow-guide";
    this.#pulseRoot.name = "hero-b:pulse-target";
    this.#protagonistRoot.name = "hero-b:life-droplet";
    this.#skyRoot.name = "hero-b:sunset-atmosphere";
    this.#root.add(
      this.#skyRoot,
      this.#forestRoot,
      this.#cityRoot,
      this.#waterRoot,
      this.#waterfallRoot,
      this.#flowRoot,
      this.#pulseRoot,
      this.#protagonistRoot,
    );
    scene.add(this.#root);

    this.#ambient = new AmbientLight(0xffd6ad, 0.3);
    this.#ambient.name = "hero-b:soft-ambient";
    this.#hemisphere = new HemisphereLight(0xffc68c, 0x203f2c, 1.08);
    this.#hemisphere.name = "hero-b:sunset-hemisphere";
    this.#sun = new DirectionalLight(0xffb36b, 5.35);
    this.#sun.name = "hero-b:sunset-sun";
    this.#sun.position.set(-10, 13, 7);
    this.#coreLight = new PointLight(0xfff1b7, 3.1, 8, 1.7);
    this.#coreLight.name = "hero-b:living-core-light";
    this.#protagonistRoot.add(this.#coreLight);
    this.#amberLight = new PointLight(0xffa33b, 1.1, 7, 1.8);
    this.#amberLight.name = "hero-b:broken-amber-beacon-light";
    this.#amberLight.position.set(6.2, 2.1, -7.5);
    // Keep the light identity in every story state. Toggling the containing
    // city group would otherwise change the renderer light topology and grow
    // shader programs on the first 58-second frame.
    this.#root.add(this.#amberLight);
    scene.add(this.#ambient, this.#hemisphere, this.#sun);

    const ground = this.#ownMaterial(standardMaterial(0xffffff, 0.94));
    ground.vertexColors = true;
    ground.map = groundTexture;
    ground.bumpMap = groundTexture;
    ground.bumpScale = 0.18;
    const rock = this.#ownMaterial(standardMaterial(0x5c6252, 0.9));
    const bark = this.#ownMaterial(standardMaterial(0x4d3527, 0.88));
    const leaf = this.#ownMaterial(standardMaterial(0x315e31, 0.78));
    leaf.map = foliageTexture;
    leaf.bumpMap = foliageTexture;
    leaf.bumpScale = 0.075;
    const grassMaterial = this.#ownMaterial(standardMaterial(0x426f3b, 0.82));
    grassMaterial.map = foliageTexture;
    grassMaterial.bumpMap = foliageTexture;
    grassMaterial.bumpScale = 0.05;
    grassMaterial.side = DoubleSide;
    const flowerMaterial = this.#ownMaterial(standardMaterial(0xe7a574, 0.62));
    flowerMaterial.emissive.setHex(0x2e1209);
    flowerMaterial.emissiveIntensity = 0.18;
    const birdMaterial = this.#ownMaterial(standardMaterial(0x342d2a, 0.66));
    birdMaterial.side = DoubleSide;
    const concrete = this.#ownMaterial(standardMaterial(0xffffff, 0.86, 0.06));
    concrete.map = concreteTexture;
    concrete.bumpMap = concreteTexture;
    concrete.bumpScale = 0.1;
    const metal = this.#ownMaterial(standardMaterial(0x51545a, 0.58, 0.68));
    const moss = this.#ownMaterial(standardMaterial(0x48643b, 0.91));
    moss.map = foliageTexture;
    moss.bumpMap = foliageTexture;
    moss.bumpScale = 0.055;
    const glass = this.#ownMaterial(physicalMaterial(0x7f9d9b, 0.34, 0.22, 1.45));
    glass.thickness = 0.14;
    glass.clearcoat = 0.7;
    const river = this.#ownMaterial(physicalMaterial(0x5ab5b2, 0.84, 0.16, 1.333));
    river.map = riverTexture;
    river.bumpMap = riverTexture;
    river.bumpScale = 0.06;
    river.clearcoat = 1;
    river.clearcoatRoughness = 0.12;
    river.iridescence = 0.1;
    river.iridescenceIOR = 1.28;
    const waterfall = this.#ownMaterial(physicalMaterial(0x8ad8d4, 0.68, 0.12, 1.333));
    waterfall.map = riverTexture;
    waterfall.clearcoat = 1;
    waterfall.iridescence = 0.08;
    waterfall.iridescenceIOR = 1.27;
    const mistMaterial = this.#ownMaterial(additiveMaterial(0xf5f1dd, 0.13));
    const cloudMaterial = this.#ownMaterial(physicalMaterial(0xf6c9a0, 0.42, 0.92, 1.02));
    const coreMaterial = this.#ownMaterial(additiveMaterial(0xfff3b0, 0.98));
    const envelopeMaterial = this.#ownMaterial(physicalMaterial(0xc7f1ce, 0.58, 0.14, 1.34));
    envelopeMaterial.thickness = 0.44;
    envelopeMaterial.clearcoat = 1;
    envelopeMaterial.iridescence = 0.42;
    envelopeMaterial.iridescenceIOR = 1.24;
    envelopeMaterial.iridescenceThicknessRange = [105, 340];
    const pulseMaterial = this.#ownMaterial(additiveMaterial(0xc5ff9c, 0.7));
    const amberMaterial = this.#ownMaterial(standardMaterial(0x6b3b16, 0.36, 0.42));
    amberMaterial.emissive.setHex(0xff7a22);
    amberMaterial.emissiveIntensity = 1.8;
    const observationMaterial = this.#ownMaterial(standardMaterial(0xe0ceb0, 0.76, 0.04));
    const skyMaterial = this.#ownMaterial(new MeshBasicNodeMaterial());
    skyMaterial.color.setHex(0xffffff);
    skyMaterial.vertexColors = true;
    skyMaterial.side = BackSide;
    skyMaterial.toneMapped = false;

    const sky = new Mesh(this.#ownGeometry(sunsetSkyGeometry()), skyMaterial);
    sky.name = "hero-b:sunset-sky-dome";
    this.#skyRoot.add(sky);
    const sunDisc = new Mesh(
      this.#ownGeometry(new SphereGeometry(1.6, 20, 14)),
      this.#ownMaterial(additiveMaterial(0xffcc72, 0.92)),
    );
    sunDisc.name = "hero-b:sun-disc";
    sunDisc.position.set(-12, 9, -22);
    this.#skyRoot.add(sunDisc);

    const terrainGeometry = this.#ownGeometry(new PlaneGeometry(38, 42, 52, 58));
    const terrainPositions = terrainGeometry.attributes.position;
    const terrainColors = new Float32Array(terrainPositions.count * 3);
    const terrainColor = new Color();
    for (let index = 0; index < terrainPositions.count; index += 1) {
      const x = terrainPositions.getX(index);
      const z = terrainPositions.getY(index) - 7;
      const height = terrainHeight(x, z, seed);
      terrainPositions.setZ(index, height);
      const wet = Math.max(0, Math.min(1, 1 - Math.abs(x - riverCenter(z)) / 7));
      terrainColor.setRGB(
        0.2 + wet * 0.12 + Math.max(0, height) * 0.025,
        0.3 + wet * 0.2 + Math.max(0, height) * 0.04,
        0.19 + wet * 0.1,
      );
      terrainColors[index * 3] = terrainColor.r;
      terrainColors[index * 3 + 1] = terrainColor.g;
      terrainColors[index * 3 + 2] = terrainColor.b;
    }
    terrainPositions.needsUpdate = true;
    terrainGeometry.setAttribute("color", new Float32BufferAttribute(terrainColors, 3));
    terrainGeometry.computeVertexNormals();
    const terrain = new Mesh(terrainGeometry, ground);
    terrain.name = "hero-b:terrain-heightfield";
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(0, -1.2, -7);
    this.#forestRoot.add(terrain);

    const riverGeometry = this.#ownGeometry(new PlaneGeometry(5.2, 34, 12, 48));
    const riverPositions = riverGeometry.attributes.position;
    for (let index = 0; index < riverPositions.count; index += 1) {
      const x = riverPositions.getX(index);
      const z = riverPositions.getY(index) - 6;
      riverPositions.setX(index, x + riverCenter(z));
      riverPositions.setZ(index, Math.sin(z * 0.24) * 0.04);
    }
    riverPositions.needsUpdate = true;
    riverGeometry.computeVertexNormals();
    const riverMesh = new Mesh(riverGeometry, river);
    riverMesh.name = "hero-b:wide-river";
    riverMesh.rotation.x = -Math.PI / 2;
    riverMesh.position.set(0, -1.06, -5.5);
    riverMesh.renderOrder = 2;
    this.#waterRoot.add(riverMesh);

    const waterfallGeometry = this.#ownGeometry(new PlaneGeometry(5.4, 7.4, 14, 22));
    const waterfallPositions = waterfallGeometry.attributes.position;
    for (let index = 0; index < waterfallPositions.count; index += 1) {
      const x = waterfallPositions.getX(index);
      const y = waterfallPositions.getY(index);
      waterfallPositions.setZ(index, Math.sin(x * 1.8 + y * 0.7) * 0.12);
    }
    waterfallPositions.needsUpdate = true;
    waterfallGeometry.computeVertexNormals();
    const waterfallMesh = new Mesh(waterfallGeometry, waterfall);
    waterfallMesh.name = "hero-b:connected-waterfall";
    waterfallMesh.position.set(0.3, 2.1, -18.2);
    waterfallMesh.renderOrder = 3;
    this.#waterfallRoot.add(waterfallMesh);

    const dummy = new Object3D();
    const trunkGeometry = this.#ownGeometry(new CylinderGeometry(0.16, 0.3, 1, 7, 1));
    const branchGeometry = this.#ownGeometry(new CylinderGeometry(0.07, 0.13, 1, 7, 1));
    const crownGeometry = this.#ownGeometry(new IcosahedronGeometry(1, 2));
    const treeTrunks = this.#treeTrunks = new InstancedMesh(trunkGeometry, bark, 48);
    const treeCrowns = this.#treeCrowns = new InstancedMesh(crownGeometry, leaf, 48);
    const treeCrownLobeA = new InstancedMesh(crownGeometry, leaf, 48);
    const treeCrownLobeB = new InstancedMesh(crownGeometry, leaf, 48);
    const treeCrownLobes = this.#treeCrownLobes = Object.freeze([
      treeCrownLobeA,
      treeCrownLobeB,
    ]);
    const treeBranches = this.#treeBranches = new InstancedMesh(branchGeometry, bark, 96);
    treeTrunks.name = "hero-b:stable-tree-trunks";
    treeCrowns.name = "hero-b:stable-tree-crowns";
    treeCrownLobeA.name = "hero-b:tree-crown-lobes-a";
    treeCrownLobeB.name = "hero-b:tree-crown-lobes-b";
    treeBranches.name = "hero-b:tree-branches";
    for (let index = 0; index < 48; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const z = random.range(-17, 10);
      const center = riverCenter(z);
      const x = center + side * random.range(3.7, 15.5);
      const groundY = terrainHeight(x, z, seed) - 0.9;
      const height = random.range(2.6, 5.7);
      const width = random.range(0.75, 1.45);
      if (Math.abs(x - center) < SAFE_CORRIDOR_HALF_WIDTH) this.#safeCorridorClear = false;
      dummy.position.set(x, groundY + height * 0.5, z);
      dummy.rotation.set(0, random.range(0, TAU), 0);
      dummy.scale.set(random.range(0.75, 1.18), height, random.range(0.75, 1.18));
      dummy.updateMatrix();
      treeTrunks.setMatrixAt(index, dummy.matrix);
      dummy.position.set(x, groundY + height + width * 0.8, z);
      dummy.rotation.set(random.range(-0.06, 0.06), random.range(0, TAU), random.range(-0.06, 0.06));
      dummy.scale.set(width * 1.15, width, width * 1.05);
      dummy.updateMatrix();
      treeCrowns.setMatrixAt(index, dummy.matrix);

      const lobeAngle = hashedUnit(index, 0, seed ^ 0xa31c_7d92) * TAU;
      const lobeLift = hashedUnit(index, 1, seed ^ 0x6f82_451b) * 0.26;
      dummy.position.set(
        x + Math.cos(lobeAngle) * width * 0.72,
        groundY + height + width * (0.65 + lobeLift),
        z + Math.sin(lobeAngle) * width * 0.6,
      );
      dummy.rotation.set(0.08, lobeAngle, -0.06);
      dummy.scale.set(width * 0.82, width * 0.68, width * 0.76);
      dummy.updateMatrix();
      treeCrownLobeA.setMatrixAt(index, dummy.matrix);

      dummy.position.set(
        x - Math.cos(lobeAngle) * width * 0.58,
        groundY + height + width * (1.18 + lobeLift * 0.4),
        z - Math.sin(lobeAngle) * width * 0.5,
      );
      dummy.rotation.set(-0.05, lobeAngle + Math.PI * 0.5, 0.08);
      dummy.scale.set(width * 0.7, width * 0.62, width * 0.68);
      dummy.updateMatrix();
      treeCrownLobeB.setMatrixAt(index, dummy.matrix);

      for (let branchIndex = 0; branchIndex < 2; branchIndex += 1) {
        const direction = branchIndex === 0 ? -1 : 1;
        const branchAngle = lobeAngle + direction * (0.62 + hashedUnit(
          index,
          branchIndex,
          seed ^ 0x1ed4_90b7,
        ) * 0.34);
        const branchLength = height * (0.25 + hashedUnit(
          index,
          branchIndex,
          seed ^ 0xd371_6ea9,
        ) * 0.08);
        dummy.position.set(
          x + Math.cos(branchAngle) * branchLength * 0.24,
          groundY + height * (0.72 + branchIndex * 0.08),
          z + Math.sin(branchAngle) * branchLength * 0.24,
        );
        dummy.rotation.set(Math.sin(branchAngle) * 0.08, branchAngle, direction * 0.82);
        dummy.scale.set(width * 0.68, branchLength, width * 0.68);
        dummy.updateMatrix();
        treeBranches.setMatrixAt(index * 2 + branchIndex, dummy.matrix);
      }
    }
    treeTrunks.instanceMatrix.needsUpdate = true;
    treeCrowns.instanceMatrix.needsUpdate = true;
    treeCrownLobeA.instanceMatrix.needsUpdate = true;
    treeCrownLobeB.instanceMatrix.needsUpdate = true;
    treeBranches.instanceMatrix.needsUpdate = true;
    this.#forestRoot.add(treeTrunks, treeBranches, treeCrowns, ...treeCrownLobes);

    const grassGeometry = this.#ownGeometry(grassTuftGeometry());
    const grass = this.#grass = new InstancedMesh(grassGeometry, grassMaterial, 72);
    grass.name = "hero-b:stable-grass-clusters";
    for (let index = 0; index < 72; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const z = random.range(-15, 11);
      const x = riverCenter(z) + side * random.range(3.15, 13.5);
      dummy.position.set(x, terrainHeight(x, z, seed) - 0.5, z);
      dummy.rotation.set(0, random.range(0, TAU), random.range(-0.12, 0.12));
      const scale = random.range(0.55, 1.45);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      grass.setMatrixAt(index, dummy.matrix);
    }
    grass.instanceMatrix.needsUpdate = true;
    this.#forestRoot.add(grass);

    const flowerGeometry = this.#ownGeometry(new IcosahedronGeometry(0.14, 1));
    const flowers = this.#flowers = new InstancedMesh(flowerGeometry, flowerMaterial, 36);
    flowers.name = "hero-b:forest-flowers";
    for (let index = 0; index < 36; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const z = random.range(-12, 9);
      const x = riverCenter(z) + side * random.range(3.05, 9.5);
      dummy.position.set(x, terrainHeight(x, z, seed) - 0.32, z);
      dummy.rotation.set(0, random.range(0, TAU), 0);
      const scale = random.range(0.7, 1.45);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      flowers.setMatrixAt(index, dummy.matrix);
    }
    flowers.instanceMatrix.needsUpdate = true;
    this.#forestRoot.add(flowers);

    const birdGeometry = this.#ownGeometry(flyingBirdGeometry());
    const birds = this.#birds = new InstancedMesh(birdGeometry, birdMaterial, 22);
    birds.name = "hero-b:bird-flow";
    for (let index = 0; index < 22; index += 1) {
      dummy.position.set(
        -7 + (index % 11) * 1.35,
        4.8 + (index % 4) * 0.46,
        -9 + Math.floor(index / 11) * 3.2 + Math.sin(index) * 0.6,
      );
      dummy.rotation.set(0, 0, Math.PI / 2 + (index % 3 - 1) * 0.12);
      const scale = 0.7 + (index % 4) * 0.12;
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      birds.setMatrixAt(index, dummy.matrix);
    }
    birds.instanceMatrix.needsUpdate = true;
    this.#flowRoot.add(birds);

    const mistGeometry = this.#ownGeometry(new SphereGeometry(0.58, 10, 7));
    const mist = this.#mist = new InstancedMesh(mistGeometry, mistMaterial, 20);
    mist.name = "hero-b:waterfall-mist";
    for (let index = 0; index < 20; index += 1) {
      const angle = (index / 20) * TAU;
      dummy.position.set(
        0.3 + Math.cos(angle) * (0.8 + (index % 4) * 0.42),
        -0.2 + (index % 5) * 0.42,
        -16.6 + Math.sin(angle) * 1.15,
      );
      dummy.rotation.set(0, angle, 0);
      const scale = 0.65 + (index % 3) * 0.32;
      dummy.scale.set(scale * 1.45, scale * 0.7, scale);
      dummy.updateMatrix();
      mist.setMatrixAt(index, dummy.matrix);
    }
    mist.instanceMatrix.needsUpdate = true;
    this.#waterfallRoot.add(mist);

    const cloudGeometry = this.#ownGeometry(new SphereGeometry(1, 12, 8));
    const clouds = this.#clouds = new InstancedMesh(cloudGeometry, cloudMaterial, 12);
    const cloudLobeA = new InstancedMesh(cloudGeometry, cloudMaterial, 12);
    const cloudLobeB = new InstancedMesh(cloudGeometry, cloudMaterial, 12);
    const cloudLobes = this.#cloudLobes = Object.freeze([cloudLobeA, cloudLobeB]);
    clouds.name = "hero-b:stable-cloud-clusters";
    cloudLobeA.name = "hero-b:cloud-lobes-a";
    cloudLobeB.name = "hero-b:cloud-lobes-b";
    for (let index = 0; index < 12; index += 1) {
      const x = -15 + index * 2.8;
      const y = 8.5 + (index % 3) * 0.8;
      const z = -18 - (index % 4) * 1.8;
      const rotationY = random.range(0, TAU);
      const scaleX = random.range(1.5, 3.2);
      const scaleY = random.range(0.45, 0.95);
      const scaleZ = random.range(0.85, 1.7);
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, rotationY, 0);
      dummy.scale.set(scaleX, scaleY, scaleZ);
      dummy.updateMatrix();
      clouds.setMatrixAt(index, dummy.matrix);

      const drift = hashedUnit(index, 0, seed ^ 0x537a_1dc9) * 0.48;
      dummy.position.set(
        x - scaleX * (0.28 + drift * 0.12),
        y + scaleY * 0.3,
        z + scaleZ * 0.08,
      );
      dummy.rotation.set(0, rotationY + 0.34, 0);
      dummy.scale.set(scaleX * 0.62, scaleY * 1.08, scaleZ * 0.76);
      dummy.updateMatrix();
      cloudLobeA.setMatrixAt(index, dummy.matrix);

      dummy.position.set(
        x + scaleX * (0.32 - drift * 0.1),
        y + scaleY * 0.18,
        z - scaleZ * 0.12,
      );
      dummy.rotation.set(0, rotationY - 0.27, 0);
      dummy.scale.set(scaleX * 0.56, scaleY * 0.92, scaleZ * 0.7);
      dummy.updateMatrix();
      cloudLobeB.setMatrixAt(index, dummy.matrix);
    }
    clouds.instanceMatrix.needsUpdate = true;
    cloudLobeA.instanceMatrix.needsUpdate = true;
    cloudLobeB.instanceMatrix.needsUpdate = true;
    this.#skyRoot.add(clouds, ...cloudLobes);

    const rockGeometry = this.#ownGeometry(organicRockGeometry(seed ^ 0x08fe_a712));
    const rocks = new InstancedMesh(rockGeometry, rock, 24);
    rocks.name = "hero-b:riverbank-rocks";
    for (let index = 0; index < 24; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const z = -14 + (index % 12) * 2.05;
      const x = riverCenter(z) + side * (3 + (index % 4) * 0.5);
      dummy.position.set(x, terrainHeight(x, z, seed) - 0.7, z);
      dummy.rotation.set(random.range(-0.2, 0.2), random.range(0, TAU), random.range(-0.15, 0.15));
      dummy.scale.set(random.range(0.35, 0.9), random.range(0.25, 0.65), random.range(0.4, 1.05));
      dummy.updateMatrix();
      rocks.setMatrixAt(index, dummy.matrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
    this.#forestRoot.add(rocks);

    this.#buildCity(
      concrete,
      metal,
      glass,
      moss,
      amberMaterial,
      observationMaterial,
      trunkGeometry,
      crownGeometry,
      bark,
      leaf,
      birdGeometry,
      birdMaterial,
    );
    this.#buildProtagonist(envelopeMaterial, coreMaterial);
    this.#pulseRing = this.#buildPulseTarget(pulseMaterial, leaf, flowerMaterial);

    // Precompile every reachable graph before the first runtime update hides
    // the city or selects a density tier.
    this.#cityRoot.visible = true;
    this.#forestRoot.visible = true;
    this.#waterRoot.visible = true;
    this.#waterfallRoot.visible = true;
    this.#flowRoot.visible = true;
    this.#pulseRoot.visible = true;
    this.#protagonistRoot.visible = true;
    this.#initializedAllocations = this.#geometries.length + this.#materials.length + this.#textures.length;
  }

  initialize(context: FeatureInitContext): Promise<void> {
    void context;
    if (this.#state === "disposed" || this.#state === "disposing") {
      return Promise.reject(new Error("Cannot initialize a disposed forest/city Hero feature."));
    }
    this.#state = "ready";
    return Promise.resolve();
  }

  update(frame: Readonly<JourneyRenderSnapshot>, clock: VisualClock): void {
    if (this.#state !== "ready") return;
    this.#storyTime = finiteStoryTime(frame.storyTime);
    this.#shotId = frame.shotId;
    const cityVisible = this.#storyTime >= CITY_REVEAL_SECONDS && this.#storyTime < CITY_END_SECONDS;
    this.#forestRoot.visible = this.#storyTime >= 36 && this.#storyTime < CITY_END_SECONDS;
    this.#cityRoot.visible = cityVisible;
    this.#waterRoot.visible = this.#storyTime >= 36 && this.#storyTime < CITY_END_SECONDS;
    this.#waterfallRoot.visible = this.#storyTime >= 48 && this.#storyTime < CITY_END_SECONDS;
    this.#flowRoot.visible = this.#storyTime >= 44 && this.#storyTime < CITY_END_SECONDS;
    this.#pulseRoot.visible = this.#storyTime >= 54 && this.#storyTime < CITY_REVEAL_SECONDS;
    this.#protagonistRoot.visible = this.#storyTime >= 36 && this.#storyTime <= CITY_END_SECONDS;

    const time = clock.elapsedSeconds;
    this.#riverTexture.offset.y = (time * 0.035) % 1;
    this.#waterfallRoot.position.y = Math.sin(time * 0.7) * 0.035;
    this.#flowRoot.position.x = Math.sin(time * 0.22) * 0.32;
    this.#skyRoot.rotation.y = Math.sin(time * 0.025) * 0.012;
    this.#animateProtagonist(frame, time, cityVisible);
    const pulseCycle = (time * 0.31) % 1;
    this.#pulseRing.scale.setScalar(0.68 + pulseCycle * 2.25);
    this.#pulseRing.rotation.z = time * 0.1;
    this.#amberLight.intensity = cityVisible
      ? 0.45 + (Math.sin(time * 2.7) > 0.88 ? 0.65 : 0)
      : 0;

    const cityMix = Math.max(0, Math.min(1, (this.#storyTime - CITY_REVEAL_SECONDS) / 13));
    this.#backgroundColor.setRGB(
      0.78 + cityMix * 0.05,
      0.42 + cityMix * 0.03,
      0.28 + cityMix * 0.06,
    );
    this.#aerialFog.color.setRGB(0.67 + cityMix * 0.03, 0.39 + cityMix * 0.02, 0.3 + cityMix * 0.04);
    this.#aerialFog.density = 0.015 + cityMix * 0.002;
    this.#cameraForStory(cityVisible, cityMix, frame.position.x, frame.position.y);
    this.#applyDensity();
  }

  render(recorder: RenderPassRecorder): void {
    void recorder;
    // The pooled world feature owns the single persistent scene pass.
  }

  quality(profile: Readonly<RenderQualityProfile>): void {
    if (this.#state === "disposed" || this.#state === "disposing") return;
    this.#qualityTier = profile.tier;
    this.#applyDensity();
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
      this.#scene.remove(this.#root, this.#ambient, this.#hemisphere, this.#sun);
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
      for (const owned of this.#textures) {
        if (owned.disposed) continue;
        try {
          owned.texture.dispose();
          owned.disposed = true;
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        this.#state = "failed";
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Forest/city Hero feature cleanup failed.");
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

  snapshot(): Readonly<ForestCityHeroFeatureSnapshot> {
    const forestVisible = this.#forestRoot.visible;
    const cityVisible = this.#cityRoot.visible;
    return freezeSnapshot({
      state: this.#state,
      storyTime: this.#storyTime,
      shotId: this.#shotId,
      qualityTier: this.#qualityTier,
      forestPeakVisible: forestVisible,
      cityRuinsVisible: cityVisible,
      riverVisible: this.#waterRoot.visible,
      waterfallVisible: this.#waterfallRoot.visible,
      protagonistVisible: this.#protagonistRoot.visible,
      pulseTargetVisible: this.#pulseRoot.visible,
      flowGuideVisible: this.#flowRoot.visible,
      natureReadsFirst: forestVisible && (!cityVisible || this.#treeCrowns.count >= 24),
      safeCorridorClear: this.#safeCorridorClear,
      safeCorridorHalfWidth: SAFE_CORRIDOR_HALF_WIDTH,
      storySightlineOpen: this.#safeCorridorClear && this.#waterfallRoot.visible,
      hydrologyConnected: this.#waterRoot.visible && this.#waterfallRoot.visible,
      foliageTemporalStable: true,
      visibleTrees: forestVisible ? this.#treeCrowns.count : 0,
      visibleGrassClusters: forestVisible ? this.#grass.count : 0,
      visibleFlowers: forestVisible ? this.#flowers.count : 0,
      visibleBirds: this.#flowRoot.visible ? this.#birds.count : 0,
      visibleMistClusters: this.#waterfallRoot.visible ? this.#mist.count : 0,
      visibleClouds: this.#skyRoot.visible ? this.#clouds.count : 0,
      ruinTowers: this.#ruinTowers,
      floorSlabs: this.#floorSlabs,
      columnGridSegments: this.#columnGridSegments,
      facadeCells: this.#facadeCells,
      emptyBenchSeats: this.#emptyBenchSeats,
      playgroundFrames: this.#playgroundFrames,
      observationFrames: this.#observationFrames,
      amberBeacons: this.#amberBeacons,
      rooftopTrees: this.#rooftopTrees,
      windowBirds: this.#windowBirds,
      ownedGeometries: this.#geometries.filter((entry) => !entry.disposed).length,
      ownedMaterials: this.#materials.filter((entry) => !entry.disposed).length,
      ownedTextures: this.#textures.filter((entry) => !entry.disposed).length,
      ownedObjects: this.#ownedObjectCount(),
      allocationsAfterInitialize:
        this.#geometries.length + this.#materials.length + this.#textures.length - this.#initializedAllocations,
    });
  }

  #ownMaterial<T extends Material>(material: T): T {
    material.name = `hero-b:${this.#materials.length}:${material.type}`;
    this.#materials.push({ material, disposed: false });
    return material;
  }

  #ownGeometry<T extends BufferGeometry>(geometry: T): T {
    geometry.name = `hero-b:${this.#geometries.length}:${geometry.type}`;
    this.#geometries.push({ geometry, disposed: false });
    return geometry;
  }

  #ownTexture<T extends Texture>(texture: T): T {
    this.#textures.push({ texture, disposed: false });
    return texture;
  }

  #buildCity(
    concrete: Material,
    metal: Material,
    glass: Material,
    moss: Material,
    amber: Material,
    observation: Material,
    trunkGeometry: BufferGeometry,
    crownGeometry: BufferGeometry,
    bark: Material,
    leaf: Material,
    birdGeometry: BufferGeometry,
    bird: Material,
  ): void {
    const cube = this.#ownGeometry(new BoxGeometry(1, 1, 1));
    const add = (
      parent: Group,
      name: string,
      position: readonly [number, number, number],
      scale: readonly [number, number, number],
      material: Material,
    ): Mesh => {
      const mesh = new Mesh(cube, material);
      mesh.name = name;
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      parent.add(mesh);
      return mesh;
    };
    const towerX = [-10.8, -7.2, -5, -8.8, 5.2, 7.5, 10.5, 8.8] as const;
    const towerZ = [-15, -10.2, -5.3, 0.2, -14.2, -9, -4, 1.1] as const;
    for (let towerIndex = 0; towerIndex < towerX.length; towerIndex += 1) {
      const tower = new Group();
      tower.name = `hero-b:ruin-tower:${towerIndex}`;
      const x = towerX[towerIndex]!;
      const z = towerZ[towerIndex]!;
      tower.position.set(x, 0, z);
      const floors = 4 + (towerIndex % 2);
      for (let floor = 0; floor < floors; floor += 1) {
        const y = 0.2 + floor * 1.45;
        add(tower, `hero-b:floor-slab:${towerIndex}:${floor}`, [0, y, 0], [1.65, 0.12, 1.2], concrete);
        this.#floorSlabs += 1;
      }
      for (let column = 0; column < 4; column += 1) {
        const sideX = column % 2 === 0 ? -1.35 : 1.35;
        const sideZ = column < 2 ? -0.92 : 0.92;
        add(
          tower,
          `hero-b:column-grid:${towerIndex}:${column}`,
          [sideX, floors * 0.72, sideZ],
          [0.12, floors * 0.72, 0.12],
          column === towerIndex % 4 ? metal : concrete,
        );
        this.#columnGridSegments += 1;
      }
      for (let cell = 0; cell < 6; cell += 1) {
        const row = Math.floor(cell / 2);
        const column = cell % 2;
        add(
          tower,
          `hero-b:facade-cell:${towerIndex}:${cell}`,
          [(column - 0.5) * 1.15, 0.92 + row * 1.4, 1.13],
          [0.48, 0.5, 0.035],
          cell === (towerIndex + 2) % 6 ? moss : glass,
        );
        this.#facadeCells += 1;
      }
      const wallHeight = floors * 0.62;
      add(
        tower,
        `hero-b:broken-rear-wall-left:${towerIndex}`,
        [-0.82, floors * 0.72, -1.04],
        [0.54, wallHeight, 0.08],
        concrete,
      );
      add(
        tower,
        `hero-b:broken-rear-wall-right:${towerIndex}`,
        [0.92, floors * 0.62, -1.04],
        [0.43, wallHeight * 0.82, 0.08],
        concrete,
      );
      const roofMoss = add(tower, `hero-b:roof-moss:${towerIndex}`, [0, floors * 1.45 + 0.1, 0], [1.5, 0.08, 1.02], moss);
      roofMoss.rotation.z = (towerIndex % 3 - 1) * 0.035;
      const roofTreeX = towerIndex % 2 === 0 ? -0.52 : 0.52;
      add(
        tower,
        `hero-b:rooftop-planter:${towerIndex}`,
        [roofTreeX, floors * 1.45 + 0.32, -0.12],
        [0.58, 0.22, 0.52],
        concrete,
      );
      add(
        tower,
        `hero-b:vertical-garden-spine:${towerIndex}`,
        [roofTreeX, floors * 0.72, -0.84],
        [0.44, floors * 0.68, 0.16],
        towerIndex % 3 === 0 ? moss : concrete,
      );
      const roofTrunk = new Mesh(trunkGeometry, bark);
      roofTrunk.name = `hero-b:rooftop-tree-trunk:${towerIndex}`;
      roofTrunk.position.set(roofTreeX, floors * 1.45 + 0.76, -0.12);
      roofTrunk.scale.set(0.58, 0.9, 0.58);
      const roofCrown = new Mesh(crownGeometry, leaf);
      roofCrown.name = `hero-b:rooftop-tree-crown:${towerIndex}`;
      roofCrown.position.set(roofTreeX, floors * 1.45 + 1.36, -0.12);
      const roofScale = 0.4 + (towerIndex % 3) * 0.06;
      roofCrown.scale.set(roofScale * 1.08, roofScale, roofScale);
      const windowBird = new Mesh(birdGeometry, bird);
      windowBird.name = `hero-b:window-bird:${towerIndex}`;
      windowBird.position.set(
        towerIndex % 2 === 0 ? -0.55 : 0.55,
        1.08 + (towerIndex % 3) * 1.35,
        1.28,
      );
      windowBird.rotation.z = Math.PI / 2;
      windowBird.scale.setScalar(0.62);
      tower.add(roofTrunk, roofCrown, windowBird);
      this.#rooftopTrees += 1;
      this.#windowBirds += 1;
      this.#cityRoot.add(tower);
      this.#ruinTowers += 1;
      if (Math.abs(x - riverCenter(z)) < SAFE_CORRIDOR_HALF_WIDTH) this.#safeCorridorClear = false;
    }

    const bench = new Group();
    bench.name = "hero-b:empty-rectangular-bench";
    bench.position.set(3.7, -0.45, -1.2);
    for (let index = 0; index < 3; index += 1) {
      const x = -1.05 + index * 1.05;
      add(bench, `hero-b:empty-bench-seat:${index}`, [x, 0.1, 0], [0.45, 0.11, 0.48], concrete);
      add(bench, `hero-b:empty-bench-back:${index}`, [x, 0.62, -0.42], [0.45, 0.5, 0.09], concrete);
      this.#emptyBenchSeats += 1;
    }
    add(bench, "hero-b:bench-left-support", [-1.55, -0.3, 0], [0.1, 0.42, 0.12], metal);
    add(bench, "hero-b:bench-right-support", [1.55, -0.3, 0], [0.1, 0.42, 0.12], metal);
    this.#cityRoot.add(bench);

    const playground = new Group();
    playground.name = "hero-b:wind-moved-playground-frame";
    playground.position.set(-4.2, -0.3, -1.4);
    add(playground, "hero-b:playground-left-post", [-1.1, 1.25, 0], [0.1, 1.3, 0.1], metal);
    add(playground, "hero-b:playground-right-post", [1.1, 1.25, 0], [0.1, 1.3, 0.1], metal);
    add(playground, "hero-b:playground-top-beam", [0, 2.45, 0], [1.2, 0.1, 0.1], metal);
    add(playground, "hero-b:playground-empty-seat", [0, 0.55, 0], [0.42, 0.08, 0.34], concrete);
    this.#playgroundFrames += 1;
    this.#cityRoot.add(playground);

    const frame = new Group();
    frame.name = "hero-b:square-observation-frame";
    frame.position.set(5.8, 2.7, -6.2);
    frame.rotation.y = -0.08;
    add(frame, "hero-b:observation-left", [-3.2, 0, 0], [0.23, 3.25, 0.24], observation);
    add(frame, "hero-b:observation-right", [3.2, 0, 0], [0.23, 3.25, 0.24], observation);
    add(frame, "hero-b:observation-top", [0, 3.08, 0], [3.4, 0.23, 0.24], observation);
    add(frame, "hero-b:observation-bottom", [0, -3.08, 0], [3.4, 0.23, 0.24], observation);
    this.#observationFrames += 1;
    this.#cityRoot.add(frame);

    add(this.#cityRoot, "hero-b:broken-amber-beacon", [6.2, 2.1, -7.5], [0.12, 0.85, 0.12], amber);
    this.#amberBeacons += 1;
  }

  #buildProtagonist(envelope: Material, core: Material): void {
    const envelopeMesh = new Mesh(this.#ownGeometry(livingDropletGeometry()), envelope);
    envelopeMesh.name = "hero-b:protagonist-envelope";
    envelopeMesh.scale.set(0.72, 1.05, 0.5);
    const coreMesh = new Mesh(this.#ownGeometry(new SphereGeometry(0.24, 16, 12)), core);
    coreMesh.name = "hero-b:protagonist-warm-core";
    coreMesh.position.set(0, -0.04, 0.12);
    const wingGeometry = this.#ownGeometry(new IcosahedronGeometry(0.48, 2));
    const leftWing = new Mesh(wingGeometry, envelope);
    const rightWing = new Mesh(wingGeometry, envelope);
    leftWing.name = "hero-b:protagonist-left-leaf-wing";
    rightWing.name = "hero-b:protagonist-right-leaf-wing";
    leftWing.position.set(-0.62, 0.05, -0.06);
    rightWing.position.set(0.62, 0.05, -0.06);
    leftWing.scale.set(1.1, 0.22, 0.48);
    rightWing.scale.set(1.1, 0.22, 0.48);
    leftWing.rotation.z = 0.42;
    rightWing.rotation.z = -0.42;
    const tail = new Mesh(this.#ownGeometry(new ConeGeometry(0.2, 1.25, 9)), envelope);
    tail.name = "hero-b:protagonist-leaf-tail";
    tail.position.set(0, -0.86, -0.06);
    tail.rotation.z = Math.PI;
    tail.scale.set(0.7, 1, 0.54);
    this.#protagonistRoot.add(envelopeMesh, coreMesh, leftWing, rightWing, tail);
    this.#protagonistRoot.position.set(0.3, 1.2, 3.2);
  }

  #buildPulseTarget(pulse: Material, leaf: Material, flower: Material): Mesh {
    const ring = new Mesh(this.#ownGeometry(new TorusGeometry(1.3, 0.05, 8, 64)), pulse);
    ring.name = "hero-b:pulse-wave";
    ring.rotation.x = Math.PI / 2;
    const trunk = new Mesh(this.#ownGeometry(new CylinderGeometry(0.09, 0.15, 1.4, 7)), leaf);
    trunk.name = "hero-b:pulse-living-sapling";
    trunk.position.y = 0.28;
    const bloom = new Mesh(this.#ownGeometry(new IcosahedronGeometry(0.34, 1)), flower);
    bloom.name = "hero-b:pulse-flowering-crown";
    bloom.position.y = 1.05;
    bloom.scale.set(1.15, 0.72, 1.05);
    this.#pulseRoot.add(ring, trunk, bloom);
    this.#pulseRoot.position.set(-2.7, -0.35, 0.6);
    return ring;
  }

  #applyDensity(): void {
    const high = this.#qualityTier === "high";
    const balanced = this.#qualityTier === "balanced";
    const treeCount = high ? 48 : balanced ? 36 : 24;
    const grassCount = high ? 72 : balanced ? 48 : 28;
    const flowerCount = high ? 36 : balanced ? 24 : 14;
    const birdCount = high ? 22 : balanced ? 16 : 10;
    const mistCount = high ? 20 : balanced ? 14 : 8;
    const cloudCount = high ? 12 : balanced ? 9 : 6;
    this.#treeTrunks.count = treeCount;
    this.#treeCrowns.count = treeCount;
    this.#treeBranches.count = treeCount * 2;
    for (const lobe of this.#treeCrownLobes) lobe.count = treeCount;
    this.#grass.count = grassCount;
    this.#flowers.count = flowerCount;
    this.#birds.count = birdCount;
    this.#mist.count = mistCount;
    this.#clouds.count = cloudCount;
    for (const lobe of this.#cloudLobes) lobe.count = cloudCount;
  }

  #animateProtagonist(
    frame: Readonly<JourneyRenderSnapshot>,
    time: number,
    cityVisible: boolean,
  ): void {
    const cityOffset = cityVisible ? 0.85 : 0;
    this.#protagonistRoot.position.set(
      0.3 + cityOffset + frame.position.x * 2.1 + Math.sin(time * 0.51) * 0.16,
      1.25 + frame.position.y * 1.6 + Math.sin(time * 0.82) * 0.12,
      3.1 + Math.cos(time * 0.28) * 0.08,
    );
    this.#protagonistRoot.rotation.z = Math.sin(time * 0.58) * 0.075;
    const left = this.#protagonistRoot.children[2];
    const right = this.#protagonistRoot.children[3];
    if (left) left.rotation.y = Math.sin(time * 2) * 0.2;
    if (right) right.rotation.y = -Math.sin(time * 2) * 0.2;
  }

  #cameraForStory(cityVisible: boolean, cityMix: number, inputX: number, inputY: number): void {
    if (!cityVisible) {
      this.#camera.position.set(0.2 + inputX * 0.4, 4.7 + inputY * 0.3, 15.8);
      this.#camera.lookAt(0, 1.2, -8.2);
      return;
    }
    this.#camera.position.set(
      0.4 + cityMix * 1.2 + inputX * 0.32,
      5.05 + cityMix * 0.35 + inputY * 0.24,
      16.1 - cityMix * 0.35,
    );
    this.#camera.lookAt(0.15, 1.85, -10.6);
  }

  #ownedObjectCount(): number {
    let count = 0;
    this.#root.traverse((object) => {
      if (object !== this.#root) count += 1;
    });
    return this.#state === "disposed" ? 0 : count + 3;
  }
}
