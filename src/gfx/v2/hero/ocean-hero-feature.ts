import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
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
  TubeGeometry,
  Vector3,
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

const HUMAN_REVEAL_SECONDS = 18;
const WATERLINE_SECONDS = 36;
const DEFAULT_MARKER_SECONDS = 12;
const TAU = Math.PI * 2;

type HeroLifecycle = "new" | "ready" | "disposing" | "disposed" | "failed";

interface AnimatedFish {
  readonly group: Group;
  readonly phase: number;
  readonly lane: number;
  readonly speed: number;
}

interface AnimatedBubble {
  readonly mesh: Mesh;
  readonly phase: number;
  readonly radius: number;
  readonly speed: number;
}

interface AnimatedKelp {
  readonly group: Group;
  readonly phase: number;
}

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

export interface OceanHeroFeatureSnapshot {
  readonly state: HeroLifecycle;
  readonly storyTime: number;
  readonly shotId: string;
  readonly qualityTier: RenderQualityProfile["tier"];
  readonly humanArtifactsVisible: boolean;
  readonly waterlineTransition: boolean;
  readonly protagonistVisible: boolean;
  readonly pulseTargetVisible: boolean;
  readonly flowGuideVisible: boolean;
  readonly visibleFish: number;
  readonly visibleCoralClusters: number;
  readonly visibleKelp: number;
  readonly visibleBubbles: number;
  readonly vehicleModules: number;
  readonly emptySeats: number;
  readonly rectangularWindowCells: number;
  readonly railSegments: number;
  readonly ownedGeometries: number;
  readonly ownedMaterials: number;
  readonly ownedTextures: number;
  readonly ownedObjects: number;
  readonly allocationsAfterInitialize: number;
}

interface DeterministicRandom {
  next(): number;
  range(minimum: number, maximum: number): number;
}

function randomFrom(seed: number): DeterministicRandom {
  let state = (seed >>> 0) || 0x6d2b_79f5;
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

function periodicValueNoise(
  x: number,
  y: number,
  size: number,
  cells: number,
  seed: number,
): number {
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

function proceduralSurfaceTexture(
  seed: number,
  low: number,
  high: number,
  repeatX: number,
  repeatY: number,
): DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const lowChannels = [(low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff] as const;
  const highChannels = [(high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff] as const;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coarse = periodicValueNoise(x, y, size, 7, seed);
      const fine = periodicValueNoise(x, y, size, 23, seed ^ 0x51ed_270b);
      const grain = hashedUnit(x, y, seed ^ 0x9e37_79b9);
      const blend = Math.max(0, Math.min(1, coarse * 0.62 + fine * 0.28 + grain * 0.1));
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
  ior: number,
): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial();
  material.color.setHex(color);
  material.roughness = roughness;
  material.ior = ior;
  material.transparent = true;
  material.opacity = opacity;
  material.depthWrite = false;
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

function setScale(mesh: Object3D, x: number, y: number, z: number): void {
  mesh.scale.set(x, y, z);
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
    const variation = 0.82 + hashedUnit(latitude, longitude, seed) * 0.28;
    const strata = 0.94 + Math.sin(y * 9.5 + seed * 0.000_001) * 0.055;
    positions.setXYZ(
      index,
      x * variation,
      y * variation * strata * 0.78,
      z * variation,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function kelpBladeGeometry(phase: number): PlaneGeometry {
  const height = 2.7;
  const geometry = new PlaneGeometry(0.42, height, 4, 14);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const sourceY = positions.getY(index);
    const progress = (sourceY + height * 0.5) / height;
    const taper = 0.18 + Math.sin(progress * Math.PI) * 0.82;
    const current = Math.sin(progress * 4.2 + phase) * progress * 0.19;
    positions.setXYZ(
      index,
      x * taper + current,
      sourceY + height * 0.5,
      Math.sin(progress * 5.6 + phase * 0.7) * progress * 0.11,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function fishFinGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([
    -0.2, 0, 0,
    0.02, 0.34, 0,
    0.32, 0, 0,
  ], 3));
  geometry.setAttribute("uv", new Float32BufferAttribute([
    0, 0,
    0.5, 1,
    1, 0,
  ], 2));
  geometry.computeVertexNormals();
  return geometry;
}

function taperedTubeGeometry(
  curve: CatmullRomCurve3,
  tubularSegments: number,
  radius: number,
  radialSegments: number,
  tipScale: number,
): TubeGeometry {
  const geometry = new TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
  const positions = geometry.attributes.position;
  const center = new Vector3();
  for (let ring = 0; ring <= tubularSegments; ring += 1) {
    const progress = ring / tubularSegments;
    curve.getPointAt(progress, center);
    const scale = 1 + (tipScale - 1) * progress;
    for (let radial = 0; radial <= radialSegments; radial += 1) {
      const index = ring * (radialSegments + 1) + radial;
      positions.setXYZ(
        index,
        center.x + (positions.getX(index) - center.x) * scale,
        center.y + (positions.getY(index) - center.y) * scale,
        center.z + (positions.getZ(index) - center.z) * scale,
      );
    }
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
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
    const livingAsymmetry = 1 + Math.sin(normalizedY * 4.8) * 0.035;
    positions.setXYZ(
      index,
      x * lowerTaper * livingAsymmetry,
      y + (1 - Math.abs(normalizedY)) * 0.045,
      z * lowerTaper * (2 - livingAsymmetry),
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function finiteStoryTime(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MARKER_SECONDS;
  return Math.max(0, Math.min(180, value));
}

function freezeSnapshot(input: OceanHeroFeatureSnapshot): Readonly<OceanHeroFeatureSnapshot> {
  return Object.freeze({ ...input });
}

/**
 * Preallocated procedural realization for R2-G3 Hero Slice A. The feature owns
 * shared ocean art and lighting, while GFX-004 continues to own streamed chunk
 * payloads. Nothing is allocated from update(), quality(), or render().
 */
export class OceanHeroFeature implements RenderFeature {
  readonly id = "hero-slice-a-ocean";
  readonly #scene: Scene;
  readonly #camera: PerspectiveCamera;
  readonly #root = new Group();
  readonly #naturalRoot = new Group();
  readonly #vehicleRoot = new Group();
  readonly #waterlineRoot = new Group();
  readonly #protagonistRoot = new Group();
  readonly #pulseRoot = new Group();
  readonly #flowRoot = new Group();
  readonly #fish: AnimatedFish[] = [];
  readonly #bubbles: AnimatedBubble[] = [];
  readonly #kelp: AnimatedKelp[] = [];
  readonly #coralClusters: Group[] = [];
  readonly #materials: HeroOwnedMaterial[] = [];
  readonly #geometries: HeroOwnedGeometry[] = [];
  readonly #textures: HeroOwnedTexture[] = [];
  readonly #originalBackground: Scene["background"];
  readonly #originalFog: Scene["fog"];
  readonly #waterGeometry: PlaneGeometry;
  readonly #waterBasePositions: Float32Array;
  readonly #causticsRoot = new Group();
  readonly #ambient: AmbientLight;
  readonly #hemisphere: HemisphereLight;
  readonly #sun: DirectionalLight;
  readonly #coreLight: PointLight;
  readonly #backgroundColor = new Color(0x073b51);
  readonly #underwaterFog = new FogExp2(0x073b51, 0.032);
  #state: HeroLifecycle = "new";
  #storyTime = DEFAULT_MARKER_SECONDS;
  #shotId = "S03";
  #qualityTier: RenderQualityProfile["tier"] = "high";
  #initializedAllocations = 0;
  #disposePromise: Promise<void> | null = null;
  #vehicleModules = 0;
  #emptySeats = 0;
  #rectangularWindowCells = 0;
  #railSegments = 0;

  constructor(scene: Scene, camera: PerspectiveCamera, plan: Readonly<WorldPlan>) {
    this.#scene = scene;
    this.#camera = camera;
    this.#originalBackground = scene.background;
    this.#originalFog = scene.fog;
    this.#scene.background = this.#backgroundColor;
    this.#scene.fog = this.#underwaterFog;
    const opening = plan.chunks.find((chunk) => chunk.id === "S03");
    const seed = opening?.environment.ecology.seedFingerprint ?? Number(plan.worldSeed);
    const random = randomFrom(seed);
    const reefTexture = this.#ownTexture(proceduralSurfaceTexture(
      seed ^ 0x28a7_0afd,
      0x31554c,
      0x9aa58b,
      7,
      5,
    ));
    reefTexture.name = "hero-a:reef-surface-texture";
    const corrosionTexture = this.#ownTexture(proceduralSurfaceTexture(
      seed ^ 0x75d9_3cbb,
      0x23383c,
      0x74816c,
      3,
      2,
    ));
    corrosionTexture.name = "hero-a:vehicle-corrosion-texture";
    const organicDetailTexture = this.#ownTexture(proceduralSurfaceTexture(
      seed ^ 0xe1b7_45d3,
      0x7f9185,
      0xf0f3e7,
      9,
      11,
    ));
    organicDetailTexture.name = "hero-a:organic-surface-detail-texture";

    this.#root.name = "hero-a:ocean-root";
    this.#naturalRoot.name = "hero-a:natural-world";
    this.#vehicleRoot.name = "hero-a:submerged-vehicle";
    this.#waterlineRoot.name = "hero-a:waterline-transition";
    this.#protagonistRoot.name = "hero-a:life-droplet";
    this.#pulseRoot.name = "hero-a:pulse-target";
    this.#flowRoot.name = "hero-a:flow-guide";
    this.#causticsRoot.name = "hero-a:caustics";
    this.#root.add(
      this.#naturalRoot,
      this.#vehicleRoot,
      this.#waterlineRoot,
      this.#protagonistRoot,
      this.#pulseRoot,
      this.#flowRoot,
    );
    this.#naturalRoot.add(this.#causticsRoot);
    this.#scene.add(this.#root);

    this.#ambient = new AmbientLight(0x79b8c7, 0.16);
    this.#ambient.name = "hero-a:underwater-ambient";
    this.#hemisphere = new HemisphereLight(0xb9edf2, 0x020b12, 0.92);
    this.#hemisphere.name = "hero-a:water-column-light";
    this.#sun = new DirectionalLight(0xe7fbff, 4.8);
    this.#sun.name = "hero-a:surface-sun";
    this.#sun.position.set(-6, 13, 8);
    this.#coreLight = new PointLight(0xffdda0, 3.15, 7, 1.6);
    this.#coreLight.name = "hero-a:living-core-light";
    this.#protagonistRoot.add(this.#coreLight);
    this.#scene.add(this.#ambient, this.#hemisphere, this.#sun);

    const terrain = this.#ownMaterial(standardMaterial(0x183c39, 0.94));
    const sand = this.#ownMaterial(standardMaterial(0x596b5f, 0.9));
    const seafloor = this.#ownMaterial(standardMaterial(0xffffff, 0.9));
    seafloor.vertexColors = true;
    seafloor.map = reefTexture;
    seafloor.bumpMap = reefTexture;
    seafloor.bumpScale = 0.22;
    const coralRose = this.#ownMaterial(standardMaterial(0xb95e6a, 0.66));
    const coralGold = this.#ownMaterial(standardMaterial(0xc79552, 0.68));
    const coralLilac = this.#ownMaterial(standardMaterial(0x7867a8, 0.63));
    const kelpMaterial = this.#ownMaterial(standardMaterial(0x175f45, 0.78));
    const fishSilver = this.#ownMaterial(standardMaterial(0x78b8b8, 0.38, 0.08));
    const fishCoral = this.#ownMaterial(standardMaterial(0xd97561, 0.46));
    const fishEye = this.#ownMaterial(standardMaterial(0x02080a, 0.2, 0.08));
    coralRose.emissive.setHex(0x26070d);
    coralRose.emissiveIntensity = 0.32;
    coralGold.emissive.setHex(0x291704);
    coralGold.emissiveIntensity = 0.28;
    coralLilac.emissive.setHex(0x120925);
    coralLilac.emissiveIntensity = 0.3;
    coralRose.map = organicDetailTexture;
    coralRose.roughnessMap = organicDetailTexture;
    coralRose.bumpMap = organicDetailTexture;
    coralRose.bumpScale = 0.035;
    coralGold.map = organicDetailTexture;
    coralGold.roughnessMap = organicDetailTexture;
    coralGold.bumpMap = organicDetailTexture;
    coralGold.bumpScale = 0.035;
    coralLilac.map = organicDetailTexture;
    coralLilac.roughnessMap = organicDetailTexture;
    coralLilac.bumpMap = organicDetailTexture;
    coralLilac.bumpScale = 0.035;
    kelpMaterial.map = organicDetailTexture;
    kelpMaterial.roughnessMap = organicDetailTexture;
    kelpMaterial.bumpMap = organicDetailTexture;
    kelpMaterial.bumpScale = 0.025;
    kelpMaterial.side = DoubleSide;
    fishSilver.map = organicDetailTexture;
    fishSilver.roughnessMap = organicDetailTexture;
    fishSilver.bumpMap = organicDetailTexture;
    fishSilver.bumpScale = 0.018;
    fishCoral.map = organicDetailTexture;
    fishCoral.roughnessMap = organicDetailTexture;
    fishCoral.bumpMap = organicDetailTexture;
    fishCoral.bumpScale = 0.018;
    fishSilver.side = DoubleSide;
    fishCoral.side = DoubleSide;
    const vehicleMetal = this.#ownMaterial(standardMaterial(0x273a42, 0.67, 0.62));
    const vehiclePanel = this.#ownMaterial(standardMaterial(0x42565b, 0.82, 0.18));
    const darkSeat = this.#ownMaterial(standardMaterial(0x6a7770, 0.91, 0.06));
    darkSeat.emissive.setHex(0x07100e);
    darkSeat.emissiveIntensity = 0.16;
    const interiorVoid = this.#ownMaterial(standardMaterial(0x071116, 0.98, 0.04));
    const vehicleGlass = this.#ownMaterial(physicalMaterial(0x4a92a0, 0.28, 0.16, 1.45));
    terrain.map = reefTexture;
    terrain.bumpMap = reefTexture;
    terrain.bumpScale = 0.18;
    sand.map = reefTexture;
    sand.bumpMap = reefTexture;
    sand.bumpScale = 0.12;
    vehicleMetal.map = corrosionTexture;
    vehicleMetal.bumpMap = corrosionTexture;
    vehicleMetal.bumpScale = 0.08;
    vehiclePanel.map = corrosionTexture;
    vehiclePanel.bumpMap = corrosionTexture;
    vehiclePanel.bumpScale = 0.06;
    const waterMaterial = this.#ownMaterial(physicalMaterial(0x2aa6bd, 0.36, 0.18, 1.333));
    const bubbleMaterial = this.#ownMaterial(physicalMaterial(0xa5f5ff, 0.28, 0.08, 1.333));
    const causticMaterial = this.#ownMaterial(additiveMaterial(0xd7fff2, 0.115));
    const shaftMaterial = this.#ownMaterial(additiveMaterial(0x75dcff, 0.009));
    const coreMaterial = this.#ownMaterial(additiveMaterial(0xfff5ce, 0.98));
    const envelopeMaterial = this.#ownMaterial(physicalMaterial(0xa9f1f1, 0.52, 0.12, 1.333));
    const pulseMaterial = this.#ownMaterial(additiveMaterial(0x9fffe7, 0.68));
    vehicleGlass.thickness = 0.16;
    vehicleGlass.clearcoat = 1;
    waterMaterial.thickness = 0.62;
    waterMaterial.clearcoat = 1;
    waterMaterial.clearcoatRoughness = 0.09;
    waterMaterial.iridescence = 0.12;
    waterMaterial.iridescenceIOR = 1.28;
    bubbleMaterial.thickness = 0.08;
    bubbleMaterial.iridescence = 0.32;
    bubbleMaterial.iridescenceIOR = 1.25;
    envelopeMaterial.thickness = 0.48;
    envelopeMaterial.clearcoat = 1;
    envelopeMaterial.iridescence = 0.58;
    envelopeMaterial.iridescenceIOR = 1.24;
    envelopeMaterial.iridescenceThicknessRange = [110, 360];
    causticMaterial.alphaMap = reefTexture;
    causticMaterial.polygonOffset = true;
    causticMaterial.polygonOffsetFactor = -1;
    causticMaterial.polygonOffsetUnits = -1;

    const floorGeometry = this.#ownGeometry(new PlaneGeometry(34, 25, 42, 30));
    const floorPositions = floorGeometry.attributes.position;
    const floorColors = new Float32Array(floorPositions.count * 3);
    const floorColor = new Color();
    for (let index = 0; index < floorPositions.count; index += 1) {
      const x = floorPositions.getX(index);
      const y = floorPositions.getY(index);
      const relief = Math.sin(x * 0.48) * 0.2 + Math.cos(y * 0.39) * 0.16
        + Math.sin((x + y) * 0.17) * 0.24;
      floorPositions.setZ(index, relief);
      const mineral = Math.max(0, Math.min(1, 0.48 + relief * 0.8 + Math.sin(x * 0.73 + y * 0.41) * 0.18));
      floorColor.setRGB(
        0.15 + mineral * 0.21,
        0.28 + mineral * 0.2,
        0.25 + mineral * 0.13,
      );
      floorColors[index * 3] = floorColor.r;
      floorColors[index * 3 + 1] = floorColor.g;
      floorColors[index * 3 + 2] = floorColor.b;
    }
    floorPositions.needsUpdate = true;
    floorGeometry.setAttribute("color", new Float32BufferAttribute(floorColors, 3));
    floorGeometry.computeVertexNormals();
    const floor = new Mesh(floorGeometry, seafloor);
    floor.name = "hero-a:seabed";
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -3.35, -2.5);
    this.#naturalRoot.add(floor);

    const waterGeometry = this.#waterGeometry = this.#ownGeometry(new PlaneGeometry(38, 28, 32, 22));
    this.#waterBasePositions = new Float32Array(waterGeometry.attributes.position.array as ArrayLike<number>);
    const water = new Mesh(waterGeometry, waterMaterial);
    water.name = "hero-a:ocean-surface";
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 4.6, -2);
    water.renderOrder = 4;
    this.#naturalRoot.add(water);

    const rockGeometries = [
      this.#ownGeometry(organicRockGeometry(seed ^ 0x1f12_55b1)),
      this.#ownGeometry(organicRockGeometry(seed ^ 0x6ae2_c915)),
      this.#ownGeometry(organicRockGeometry(seed ^ 0x91c4_37d2)),
      this.#ownGeometry(organicRockGeometry(seed ^ 0xc06f_3a81)),
    ];
    for (let index = 0; index < 26; index += 1) {
      const rock = new Mesh(rockGeometries[index % rockGeometries.length]!, index % 3 === 0 ? terrain : sand);
      rock.name = `hero-a:reef-rock:${index}`;
      rock.position.set(
        random.range(-9.5, 9.5),
        random.range(-3.25, -2.75),
        random.range(-8, 3.5),
      );
      setScale(rock, random.range(0.25, 1.6), random.range(0.18, 0.85), random.range(0.35, 1.3));
      rock.rotation.set(random.range(-0.2, 0.2), random.range(0, TAU), random.range(-0.15, 0.15));
      this.#naturalRoot.add(rock);
    }

    const coralStemVariants = Array.from({ length: 6 }, (_, variant) => {
      const sway = (variant - 2.5) * 0.095;
      const twist = Math.sin(variant * 1.7) * 0.2;
      const points = [
        new Vector3(0, 0, 0),
        new Vector3(sway * 0.18, 0.46, twist * 0.18),
        new Vector3(sway * 0.55, 1.02, twist * 0.52),
        new Vector3(sway, 1.56, twist),
      ];
      return Object.freeze({
        geometry: this.#ownGeometry(taperedTubeGeometry(
          new CatmullRomCurve3(points),
          16,
          0.125,
          8,
          0.38,
        )),
        tip: points[points.length - 1]!,
      });
    });
    const coralLateralVariants = [-1, 1].map((direction) => {
      const tip = new Vector3(direction * 0.5, 0.58, direction * 0.07);
      return Object.freeze({
        geometry: this.#ownGeometry(taperedTubeGeometry(new CatmullRomCurve3([
          new Vector3(0, 0, 0),
          new Vector3(direction * 0.15, 0.2, 0.02),
          new Vector3(direction * 0.34, 0.4, direction * 0.05),
          tip,
        ]), 10, 0.075, 7, 0.32)),
        tip,
      });
    });
    const coralTipGeometry = this.#ownGeometry(new SphereGeometry(0.16, 10, 7));
    const coralMaterials = [coralRose, coralGold, coralLilac];
    for (let clusterIndex = 0; clusterIndex < 20; clusterIndex += 1) {
      const cluster = new Group();
      cluster.name = `hero-a:coral-cluster:${clusterIndex}`;
      const angle = random.range(0, TAU);
      const radius = random.range(3.4, 10.5);
      cluster.position.set(
        Math.cos(angle) * radius,
        -2.85,
        -2.5 + Math.sin(angle) * radius * 0.55,
      );
      const material = coralMaterials[clusterIndex % coralMaterials.length]!;
      const branchCount = 3 + (clusterIndex % 3);
      for (let branchIndex = 0; branchIndex < branchCount; branchIndex += 1) {
        const stemVariant = coralStemVariants[(clusterIndex * 3 + branchIndex) % coralStemVariants.length]!;
        const branch = new Mesh(stemVariant.geometry, material);
        branch.name = `hero-a:coral-branch:${clusterIndex}:${branchIndex}`;
        branch.position.set(
          (branchIndex - (branchCount - 1) / 2) * 0.26,
          0.06 + branchIndex * 0.045,
          Math.sin(branchIndex * 1.7) * 0.18,
        );
        branch.rotation.z = (branchIndex - (branchCount - 1) / 2) * 0.22;
        setScale(branch, 0.86, random.range(0.72, 1.22), 0.86);
        const tip = new Mesh(coralTipGeometry, material);
        tip.name = `hero-a:coral-bloom:${clusterIndex}:${branchIndex}`;
        tip.position.copy(stemVariant.tip);
        setScale(tip, 0.78, 1.12, 0.78);
        branch.add(tip);
        const lateralVariant = coralLateralVariants[(clusterIndex + branchIndex) % 2]!;
        const lateral = new Mesh(lateralVariant.geometry, material);
        lateral.name = `hero-a:coral-lateral:${clusterIndex}:${branchIndex}`;
        lateral.position.set(stemVariant.tip.x * 0.32, 0.62, stemVariant.tip.z * 0.32);
        lateral.rotation.y = (hashedUnit(
          clusterIndex,
          branchIndex,
          seed ^ 0x6dd4_390b,
        ) * 2 - 1) * 0.55;
        const lateralBloom = new Mesh(coralTipGeometry, material);
        lateralBloom.name = `hero-a:coral-side-bloom:${clusterIndex}:${branchIndex}`;
        lateralBloom.position.copy(lateralVariant.tip);
        lateralBloom.scale.setScalar(0.68);
        lateral.add(lateralBloom);
        branch.add(lateral);
        cluster.add(branch);
      }
      this.#coralClusters.push(cluster);
      this.#naturalRoot.add(cluster);
    }

    const kelpBladeGeometries = [
      this.#ownGeometry(kelpBladeGeometry(0.35)),
      this.#ownGeometry(kelpBladeGeometry(2.1)),
    ];
    for (let index = 0; index < 18; index += 1) {
      const baseX = random.range(-9, 9);
      const baseZ = random.range(-8, 2);
      const points = [
        new Vector3(0, 0, 0),
        new Vector3(random.range(-0.18, 0.18), 0.75, random.range(-0.08, 0.08)),
        new Vector3(random.range(-0.32, 0.32), 1.55, random.range(-0.12, 0.12)),
        new Vector3(random.range(-0.42, 0.42), random.range(2.1, 3.15), random.range(-0.18, 0.18)),
      ];
      const geometry = this.#ownGeometry(taperedTubeGeometry(
        new CatmullRomCurve3(points),
        10,
        0.075,
        6,
        0.28,
      ));
      const strand = new Mesh(geometry, kelpMaterial);
      strand.name = `hero-a:kelp-strand:${index}`;
      const group = new Group();
      group.name = `hero-a:kelp:${index}`;
      group.position.set(baseX, -3.1, baseZ);
      group.add(strand);
      for (let bladeIndex = 0; bladeIndex < 2; bladeIndex += 1) {
        const blade = new Mesh(kelpBladeGeometries[(index + bladeIndex) % 2]!, kelpMaterial);
        blade.name = `hero-a:kelp-blade:${index}:${bladeIndex}`;
        blade.position.set((bladeIndex - 0.5) * 0.1, 0, bladeIndex === 0 ? -0.06 : 0.06);
        blade.rotation.y = (hashedUnit(index, bladeIndex, seed ^ 0x2331_a7c4) * 1.6 - 0.8)
          + bladeIndex * Math.PI * 0.58;
        setScale(
          blade,
          0.72 + hashedUnit(index, bladeIndex, seed ^ 0x8f4c_d189) * 0.32,
          0.72 + hashedUnit(index, bladeIndex, seed ^ 0xc401_72af) * 0.42,
          1,
        );
        group.add(blade);
      }
      this.#kelp.push({ group, phase: random.range(0, TAU) });
      this.#naturalRoot.add(group);
    }

    const fishBodyGeometry = this.#ownGeometry(new SphereGeometry(0.32, 18, 10));
    const fishTailGeometry = this.#ownGeometry(new ConeGeometry(0.22, 0.48, 3));
    const fishFin = this.#ownGeometry(fishFinGeometry());
    const fishEyeGeometry = this.#ownGeometry(new SphereGeometry(0.035, 7, 5));
    for (let index = 0; index < 28; index += 1) {
      const group = new Group();
      group.name = `hero-a:fish:${index}`;
      const material = index % 4 === 0 ? fishCoral : fishSilver;
      const body = new Mesh(fishBodyGeometry, material);
      body.name = `hero-a:fish-body:${index}`;
      const bodyScaleX = random.range(1.1, 1.8);
      const bodyScaleY = random.range(0.45, 0.74);
      const bodyScaleZ = random.range(0.5, 0.82);
      setScale(body, bodyScaleX, bodyScaleY, bodyScaleZ);
      const tail = new Mesh(fishTailGeometry, material);
      tail.name = `hero-a:fish-tail:${index}`;
      tail.rotation.z = -Math.PI / 2;
      tail.position.x = -0.52;
      const dorsal = new Mesh(fishFin, material);
      dorsal.name = `hero-a:fish-dorsal-fin:${index}`;
      dorsal.position.set(-0.02, 0.14, 0);
      setScale(dorsal, 0.72, 0.62, 0.72);
      const leftFin = new Mesh(fishFin, material);
      const rightFin = new Mesh(fishFin, material);
      leftFin.name = `hero-a:fish-pectoral-fin:${index}:left`;
      rightFin.name = `hero-a:fish-pectoral-fin:${index}:right`;
      leftFin.position.set(0.02, -0.035, 0.08);
      rightFin.position.set(0.02, -0.035, -0.08);
      leftFin.rotation.x = Math.PI / 2;
      rightFin.rotation.x = -Math.PI / 2;
      setScale(leftFin, 0.58, 0.48, 0.58);
      setScale(rightFin, 0.58, 0.48, 0.58);
      const leftEye = new Mesh(fishEyeGeometry, fishEye);
      const rightEye = new Mesh(fishEyeGeometry, fishEye);
      leftEye.name = `hero-a:fish-eye:${index}:left`;
      rightEye.name = `hero-a:fish-eye:${index}:right`;
      const eyeX = bodyScaleX * 0.235;
      const eyeZ = bodyScaleZ * 0.23;
      leftEye.position.set(eyeX, bodyScaleY * 0.08, eyeZ);
      rightEye.position.set(eyeX, bodyScaleY * 0.08, -eyeZ);
      group.add(body, tail, dorsal, leftFin, rightFin, leftEye, rightEye);
      const scale = random.range(0.55, 1.15);
      group.scale.setScalar(scale);
      this.#fish.push({
        group,
        phase: random.range(0, TAU),
        lane: random.range(-1, 1),
        speed: random.range(0.38, 0.76),
      });
      this.#flowRoot.add(group);
    }

    const bubbleGeometry = this.#ownGeometry(new SphereGeometry(0.08, 8, 6));
    for (let index = 0; index < 36; index += 1) {
      const bubble = new Mesh(bubbleGeometry, bubbleMaterial);
      bubble.name = `hero-a:flow-bubble:${index}`;
      const radius = random.range(0.55, 1.7);
      setScale(bubble, radius, radius, radius);
      this.#bubbles.push({
        mesh: bubble,
        phase: random.range(0, TAU),
        radius: random.range(0.7, 2.9),
        speed: random.range(0.34, 0.82),
      });
      this.#flowRoot.add(bubble);
    }

    const causticGeometry = this.#ownGeometry(new PlaneGeometry(2.4, 2.4, 3, 3));
    for (let index = 0; index < 18; index += 1) {
      const caustic = new Mesh(causticGeometry, causticMaterial);
      caustic.name = `hero-a:caustic-patch:${index}`;
      caustic.position.set(random.range(-9, 9), -3.105, random.range(-7, 2));
      caustic.rotation.x = -Math.PI / 2;
      caustic.rotation.z = random.range(0, TAU);
      setScale(caustic, random.range(0.55, 1.65), random.range(0.38, 1.05), 1);
      this.#causticsRoot.add(caustic);
    }

    const shaftGeometry = this.#ownGeometry(new ConeGeometry(2.4, 12, 20, 1, true));
    for (let index = 0; index < 5; index += 1) {
      const shaft = new Mesh(shaftGeometry, shaftMaterial);
      shaft.name = `hero-a:light-shaft:${index}`;
      shaft.position.set(-7 + index * 3.5, 1.9, -5 - (index % 2) * 2);
      shaft.rotation.z = (index - 2) * 0.05;
      setScale(shaft, 0.58 + (index % 2) * 0.22, 1, 0.42);
      this.#naturalRoot.add(shaft);
    }

    this.#buildProtagonist(envelopeMaterial, coreMaterial);
    this.#protagonistRoot.scale.setScalar(0.68);
    this.#buildPulseTarget(pulseMaterial, coralGold, coralRose);
    this.#buildVehicle(
      vehicleMetal,
      vehiclePanel,
      darkSeat,
      interiorVoid,
      vehicleGlass,
      kelpMaterial,
      coralRose,
    );
    this.#buildWaterline(bubbleMaterial, this.#ownMaterial(additiveMaterial(0xe9ffff, 0.44)));

    // Keep all topology visible through compile-before-ready. The first update
    // applies the exact story boundary before a runtime frame is submitted.
    this.#vehicleRoot.visible = true;
    this.#waterlineRoot.visible = true;
    this.#protagonistRoot.visible = true;
    this.#pulseRoot.visible = true;
    this.#flowRoot.visible = true;
    this.#initializedAllocations = this.#geometries.length + this.#materials.length + this.#textures.length;
  }

  initialize(context: FeatureInitContext): Promise<void> {
    void context;
    if (this.#state === "disposed" || this.#state === "disposing") {
      return Promise.reject(new Error("Cannot initialize a disposed ocean Hero feature."));
    }
    this.#state = "ready";
    return Promise.resolve();
  }

  update(frame: Readonly<JourneyRenderSnapshot>, clock: VisualClock): void {
    if (this.#state !== "ready") return;
    this.#storyTime = finiteStoryTime(frame.storyTime);
    this.#shotId = frame.shotId;
    const underwater = this.#storyTime < WATERLINE_SECONDS + 1.4;
    const revealVehicle = this.#storyTime >= HUMAN_REVEAL_SECONDS && this.#storyTime < WATERLINE_SECONDS;
    this.#vehicleRoot.visible = revealVehicle;
    this.#waterlineRoot.visible = this.#storyTime >= 34 && this.#storyTime <= 42;
    this.#naturalRoot.visible = this.#storyTime < 42;
    this.#protagonistRoot.visible = this.#storyTime <= 44;
    this.#pulseRoot.visible = this.#storyTime >= 8 && this.#storyTime < 18;
    this.#flowRoot.visible = this.#storyTime < 42;

    const motionTime = clock.elapsedSeconds;
    this.#animateWater(motionTime);
    this.#animateFish(motionTime);
    this.#animateBubbles(motionTime);
    this.#animateKelp(motionTime);
    this.#animateProtagonist(frame, motionTime);
    this.#animatePulse(motionTime);
    this.#causticsRoot.rotation.y = Math.sin(motionTime * 0.11) * 0.08;

    const transition = Math.max(0, Math.min(1, (this.#storyTime - 34.5) / 3.5));
    if (underwater) {
      const deep = 1 - Math.max(0, Math.min(1, this.#storyTime / 38));
      this.#backgroundColor.setRGB(
        0.012 + transition * 0.08,
        0.12 + deep * 0.055 + transition * 0.23,
        0.19 + deep * 0.07 + transition * 0.3,
      );
      this.#underwaterFog.color.setHex(transition > 0.45 ? 0x276f82 : 0x073b51);
      this.#underwaterFog.density = 0.032 - transition * 0.012;
    } else {
      this.#backgroundColor.setHex(0x87c9d5);
      this.#underwaterFog.color.setHex(0x8bcbd0);
      this.#underwaterFog.density = 0.008;
    }
    this.#cameraForStory(this.#storyTime, transition, frame.position.x, frame.position.y);
    this.#applyDensity();
    if (revealVehicle) {
      for (const cluster of this.#coralClusters) {
        if (Math.abs(cluster.position.x) < 3.7 && cluster.position.z > -6.4) cluster.visible = false;
      }
    }
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
          : new AggregateError(failures, "Ocean Hero feature cleanup failed.");
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

  snapshot(): Readonly<OceanHeroFeatureSnapshot> {
    return freezeSnapshot({
      state: this.#state,
      storyTime: this.#storyTime,
      shotId: this.#shotId,
      qualityTier: this.#qualityTier,
      humanArtifactsVisible: this.#vehicleRoot.visible,
      waterlineTransition: this.#waterlineRoot.visible,
      protagonistVisible: this.#protagonistRoot.visible,
      pulseTargetVisible: this.#pulseRoot.visible,
      flowGuideVisible: this.#flowRoot.visible,
      visibleFish: this.#fish.filter((entry) => entry.group.visible && this.#flowRoot.visible).length,
      visibleCoralClusters: this.#coralClusters.filter((entry) => entry.visible && this.#naturalRoot.visible).length,
      visibleKelp: this.#kelp.filter((entry) => entry.group.visible && this.#naturalRoot.visible).length,
      visibleBubbles: this.#bubbles.filter((entry) => entry.mesh.visible && this.#flowRoot.visible).length,
      vehicleModules: this.#vehicleModules,
      emptySeats: this.#emptySeats,
      rectangularWindowCells: this.#rectangularWindowCells,
      railSegments: this.#railSegments,
      ownedGeometries: this.#geometries.filter((entry) => !entry.disposed).length,
      ownedMaterials: this.#materials.filter((entry) => !entry.disposed).length,
      ownedTextures: this.#textures.filter((entry) => !entry.disposed).length,
      ownedObjects: this.#ownedObjectCount(),
      allocationsAfterInitialize:
        this.#geometries.length + this.#materials.length + this.#textures.length - this.#initializedAllocations,
    });
  }

  #ownMaterial<T extends Material>(material: T): T {
    material.name = `hero-a:${this.#materials.length}:${material.type}`;
    this.#materials.push({ material, disposed: false });
    return material;
  }

  #ownGeometry<T extends BufferGeometry>(geometry: T): T {
    geometry.name = `hero-a:${this.#geometries.length}:${geometry.type}`;
    this.#geometries.push({ geometry, disposed: false });
    return geometry;
  }

  #ownTexture<T extends Texture>(texture: T): T {
    this.#textures.push({ texture, disposed: false });
    return texture;
  }

  #buildProtagonist(envelope: Material, core: Material): void {
    const envelopeGeometry = this.#ownGeometry(livingDropletGeometry());
    const envelopeMesh = new Mesh(envelopeGeometry, envelope);
    envelopeMesh.name = "hero-a:protagonist-envelope";
    setScale(envelopeMesh, 0.72, 1.05, 0.5);
    const coreGeometry = this.#ownGeometry(new SphereGeometry(0.25, 16, 12));
    const coreMesh = new Mesh(coreGeometry, core);
    coreMesh.name = "hero-a:protagonist-warm-core";
    coreMesh.position.set(0, -0.05, 0.12);
    const finGeometry = this.#ownGeometry(new SphereGeometry(0.48, 14, 10));
    const leftFin = new Mesh(finGeometry, envelope);
    const rightFin = new Mesh(finGeometry, envelope);
    leftFin.name = "hero-a:protagonist-left-fin";
    rightFin.name = "hero-a:protagonist-right-fin";
    leftFin.position.set(-0.66, 0, -0.05);
    rightFin.position.set(0.66, 0, -0.05);
    setScale(leftFin, 1.25, 0.18, 0.54);
    setScale(rightFin, 1.25, 0.18, 0.54);
    leftFin.rotation.z = 0.28;
    rightFin.rotation.z = -0.28;
    const tailGeometry = this.#ownGeometry(new ConeGeometry(0.25, 1.6, 10, 4));
    const tail = new Mesh(tailGeometry, envelope);
    tail.name = "hero-a:protagonist-short-water-tail";
    tail.position.set(0, -0.98, -0.05);
    tail.rotation.z = Math.PI;
    setScale(tail, 0.68, 1, 0.52);
    this.#protagonistRoot.add(envelopeMesh, coreMesh, leftFin, rightFin, tail);
    this.#protagonistRoot.position.set(0.2, 0.1, 2.25);
  }

  #buildPulseTarget(pulse: Material, coralGold: Material, coralRose: Material): void {
    const ringGeometry = this.#ownGeometry(new TorusGeometry(1.25, 0.045, 8, 64));
    const ring = new Mesh(ringGeometry, pulse);
    ring.name = "hero-a:pulse-wave";
    ring.rotation.x = Math.PI / 2;
    this.#pulseRoot.add(ring);
    const targetGeometry = this.#ownGeometry(new IcosahedronGeometry(0.48, 2));
    const bud = new Mesh(targetGeometry, coralGold);
    bud.name = "hero-a:pulse-living-target";
    setScale(bud, 0.72, 1.35, 0.72);
    const bloom = new Mesh(targetGeometry, coralRose);
    bloom.name = "hero-a:pulse-new-life-bloom";
    bloom.position.set(0, 0.65, 0);
    setScale(bloom, 0.58, 0.42, 0.58);
    this.#pulseRoot.add(bud, bloom);
    this.#pulseRoot.position.set(2.1, -1.7, 0.2);
  }

  #buildVehicle(
    metal: Material,
    panel: Material,
    seat: Material,
    interior: Material,
    glass: Material,
    kelp: Material,
    coral: Material,
  ): void {
    const cube = this.#ownGeometry(new BoxGeometry(1, 1, 1));
    const railGeometry = this.#ownGeometry(new CylinderGeometry(0.045, 0.045, 1, 8));
    const addModule = (
      name: string,
      position: readonly [number, number, number],
      scale: readonly [number, number, number],
      material: Material,
    ): Mesh => {
      const mesh = new Mesh(cube, material);
      mesh.name = name;
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      this.#vehicleRoot.add(mesh);
      this.#vehicleModules += 1;
      return mesh;
    };
    const rail = (
      name: string,
      position: readonly [number, number, number],
      scale: readonly [number, number, number],
      rotationZ = 0,
    ): Mesh => {
      const mesh = new Mesh(railGeometry, metal);
      mesh.name = name;
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      mesh.rotation.z = rotationZ;
      this.#vehicleRoot.add(mesh);
      this.#railSegments += 1;
      return mesh;
    };

    addModule("hero-a:vehicle-floor-slab", [0, -1.55, -1], [5.2, 0.12, 1.7], panel);
    addModule("hero-a:vehicle-roof-slab", [0, 1.58, -1], [5.2, 0.13, 1.7], panel);
    addModule("hero-a:vehicle-rear-panel", [-5.05, 0, -1], [0.15, 1.65, 1.7], metal);
    addModule("hero-a:vehicle-interior-void", [0, 0.05, -1.6], [4.92, 1.35, 0.06], interior);
    addModule("hero-a:vehicle-lower-side-band", [0, -1.08, 0.7], [5.05, 0.34, 0.09], panel);
    addModule("hero-a:vehicle-upper-side-band", [0, 1.26, 0.7], [5.05, 0.21, 0.09], panel);
    for (let bay = 0; bay < 7; bay += 1) {
      const x = -4.25 + bay * 1.42;
      addModule(`hero-a:vehicle-window-glass:${bay}`, [x, 0.24, 0.64], [0.53, 0.59, 0.035], glass);
      addModule(`hero-a:vehicle-window-sill:${bay}`, [x, -0.45, 0.68], [0.62, 0.08, 0.08], metal);
      addModule(`hero-a:vehicle-window-head:${bay}`, [x, 0.92, 0.68], [0.62, 0.08, 0.08], metal);
      addModule(`hero-a:vehicle-window-left:${bay}`, [x - 0.62, 0.24, 0.68], [0.07, 0.68, 0.08], metal);
      addModule(`hero-a:vehicle-window-right:${bay}`, [x + 0.62, 0.24, 0.68], [0.07, 0.68, 0.08], metal);
      this.#rectangularWindowCells += 1;
    }
    for (let seatIndex = 0; seatIndex < 5; seatIndex += 1) {
      const x = -3.25 + seatIndex * 1.65;
      addModule(`hero-a:empty-seat-base:${seatIndex}`, [x, -0.9, -0.35], [0.62, 0.12, 0.52], seat);
      addModule(`hero-a:empty-seat-back:${seatIndex}`, [x, -0.34, -0.78], [0.62, 0.58, 0.1], seat);
      this.#emptySeats += 1;
    }
    addModule("hero-a:vehicle-door-threshold", [4.55, -0.48, 0.7], [0.52, 0.08, 0.1], metal);
    addModule("hero-a:vehicle-door-head", [4.55, 1.23, 0.7], [0.52, 0.08, 0.1], metal);
    addModule("hero-a:vehicle-door-left", [4.03, 0.38, 0.7], [0.07, 0.85, 0.1], metal);
    addModule("hero-a:vehicle-door-right", [5.07, 0.38, 0.7], [0.07, 0.85, 0.1], metal);
    for (let index = 0; index < 6; index += 1) {
      rail(`hero-a:vehicle-hand-rail:${index}`, [-4 + index * 1.55, 0.35, -0.2], [1, 1.6, 1]);
    }
    rail("hero-a:vehicle-long-rail", [0, 1.2, -0.2], [1, 4.8, 1], Math.PI / 2);

    const colonized = new Group();
    colonized.name = "hero-a:vehicle-living-colonization";
    const stemGeometry = this.#ownGeometry(new CylinderGeometry(0.08, 0.13, 1, 7));
    const bloomGeometry = this.#ownGeometry(new IcosahedronGeometry(0.18, 1));
    for (let index = 0; index < 14; index += 1) {
      const stem = new Mesh(stemGeometry, index % 2 ? kelp : coral);
      stem.name = `hero-a:vehicle-colonization-stem:${index}`;
      stem.position.set(-4.6 + index * 0.72, -1.3, 0.85 + Math.sin(index) * 0.18);
      stem.rotation.z = (index % 3 - 1) * 0.18;
      stem.scale.y = 0.45 + (index % 5) * 0.14;
      const bloom = new Mesh(bloomGeometry, coral);
      bloom.name = `hero-a:vehicle-colonization-bloom:${index}`;
      bloom.position.y = 0.56;
      stem.add(bloom);
      colonized.add(stem);
    }
    this.#vehicleRoot.add(colonized);
    this.#vehicleRoot.position.set(-0.3, -0.22, -3.5);
    this.#vehicleRoot.rotation.y = -0.13;
  }

  #buildWaterline(bubble: Material, foam: Material): void {
    const foamGeometry = this.#ownGeometry(new SphereGeometry(0.18, 9, 7));
    for (let index = 0; index < 34; index += 1) {
      const mesh = new Mesh(foamGeometry, index % 3 === 0 ? foam : bubble);
      mesh.name = `hero-a:waterline-foam:${index}`;
      const angle = (index / 34) * TAU;
      mesh.position.set(
        Math.cos(angle) * (1.4 + (index % 5) * 0.35),
        4.58 + Math.sin(index * 1.9) * 0.15,
        -1 + Math.sin(angle) * (1 + (index % 4) * 0.28),
      );
      const scale = 0.55 + (index % 4) * 0.18;
      mesh.scale.setScalar(scale);
      this.#waterlineRoot.add(mesh);
    }
  }

  #applyDensity(): void {
    const fishLimit = this.#qualityTier === "high" ? 28 : this.#qualityTier === "balanced" ? 22 : 16;
    const bubbleLimit = this.#qualityTier === "high" ? 36 : this.#qualityTier === "balanced" ? 28 : 20;
    const coralLimit = this.#qualityTier === "high" ? 20 : this.#qualityTier === "balanced" ? 17 : 13;
    const kelpLimit = this.#qualityTier === "high" ? 18 : this.#qualityTier === "balanced" ? 15 : 11;
    for (let index = 0; index < this.#fish.length; index += 1) this.#fish[index]!.group.visible = index < fishLimit;
    for (let index = 0; index < this.#bubbles.length; index += 1) this.#bubbles[index]!.mesh.visible = index < bubbleLimit;
    for (let index = 0; index < this.#coralClusters.length; index += 1) this.#coralClusters[index]!.visible = index < coralLimit;
    for (let index = 0; index < this.#kelp.length; index += 1) this.#kelp[index]!.group.visible = index < kelpLimit;
  }

  #animateWater(time: number): void {
    const positions = this.#waterGeometry.attributes.position;
    for (let index = 0; index < positions.count; index += 1) {
      const offset = index * 3;
      const x = this.#waterBasePositions[offset] ?? 0;
      const y = this.#waterBasePositions[offset + 1] ?? 0;
      const wave = Math.sin(x * 0.42 + time * 0.72) * 0.12
        + Math.sin(y * 0.63 - time * 0.46) * 0.065
        + Math.cos((x + y) * 0.19 + time * 0.31) * 0.04;
      positions.setZ(index, wave);
    }
    positions.needsUpdate = true;
  }

  #animateFish(time: number): void {
    for (let index = 0; index < this.#fish.length; index += 1) {
      const entry = this.#fish[index]!;
      const travel = ((time * entry.speed + entry.phase) % 15) - 7.5;
      const direction = index % 3 === 0 ? -1 : 1;
      entry.group.position.set(
        travel * direction,
        -0.25 + entry.lane * 1.75 + Math.sin(time * 0.7 + entry.phase) * 0.22,
        -1.8 - (index % 6) * 0.72 + Math.cos(entry.phase + time * 0.19) * 0.36,
      );
      entry.group.rotation.y = direction > 0 ? 0 : Math.PI;
      entry.group.rotation.z = Math.sin(time * 1.1 + entry.phase) * 0.05;
    }
  }

  #animateBubbles(time: number): void {
    for (let index = 0; index < this.#bubbles.length; index += 1) {
      const entry = this.#bubbles[index]!;
      const height = ((time * entry.speed + entry.phase) % 7.3) - 3.1;
      entry.mesh.position.set(
        Math.sin(entry.phase + height * 0.3) * entry.radius,
        height,
        1.1 - (index % 7) * 0.75 + Math.cos(entry.phase * 1.7) * 0.4,
      );
    }
  }

  #animateKelp(time: number): void {
    for (const entry of this.#kelp) {
      entry.group.rotation.z = Math.sin(time * 0.52 + entry.phase) * 0.075;
      entry.group.rotation.x = Math.cos(time * 0.41 + entry.phase) * 0.028;
    }
  }

  #animateProtagonist(frame: Readonly<JourneyRenderSnapshot>, time: number): void {
    const reveal = Math.max(0, Math.min(1, (this.#storyTime - 18) / 5));
    const surface = Math.max(0, Math.min(1, (this.#storyTime - 34) / 3.5));
    this.#protagonistRoot.position.set(
      0.2 + reveal * 3.4 + frame.position.x * 2.2 + Math.sin(time * 0.55) * 0.16,
      0.15 + surface * 4.25 + frame.position.y * 1.7 + Math.sin(time * 0.88) * 0.12,
      2.2 + Math.cos(time * 0.31) * 0.08,
    );
    this.#protagonistRoot.rotation.z = Math.sin(time * 0.62) * 0.08;
    const fins = this.#protagonistRoot.children.filter((child) => child.name.includes("-fin"));
    if (fins[0]) fins[0].rotation.y = Math.sin(time * 2.1) * 0.22;
    if (fins[1]) fins[1].rotation.y = -Math.sin(time * 2.1) * 0.22;
  }

  #animatePulse(time: number): void {
    const ring = this.#pulseRoot.children.find((child) => child.name === "hero-a:pulse-wave");
    if (!ring) return;
    const cycle = (time * 0.34) % 1;
    const scale = 0.65 + cycle * 2.1;
    ring.scale.setScalar(scale);
    ring.rotation.z = time * 0.12;
  }

  #cameraForStory(storyTime: number, transition: number, inputX: number, inputY: number): void {
    if (storyTime < HUMAN_REVEAL_SECONDS) {
      this.#camera.position.set(0.3 + inputX * 0.42, 0.65 + inputY * 0.28, 11.2);
      this.#camera.lookAt(0, -0.55, -1.8);
      return;
    }
    if (storyTime < WATERLINE_SECONDS) {
      const reveal = Math.min(1, (storyTime - HUMAN_REVEAL_SECONDS) / 9);
      this.#camera.position.set(0.8 + reveal * 3.8 + inputX * 0.3, 0.72 + reveal * 0.45, 11 - reveal * 1.1);
      this.#camera.lookAt(-0.4, -0.35, -3.4);
      return;
    }
    this.#camera.position.set(
      4.55 - transition * 3.2,
      1.2 + transition * 5,
      9.9 - transition * 2.5,
    );
    this.#camera.lookAt(0, 3.8 + transition * 0.7, -1.4);
  }

  #ownedObjectCount(): number {
    let count = 0;
    this.#root.traverse((object) => {
      if (object !== this.#root) count += 1;
    });
    return this.#state === "disposed" ? 0 : count + 3;
  }
}
