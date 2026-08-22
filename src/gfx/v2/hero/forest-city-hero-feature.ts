import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
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
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  NoColorSpace,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type Material,
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

interface HeroSurfaceTextureLoad {
  readonly albedo: Texture;
  readonly bump: Texture;
  readonly url: string;
}

interface HeroSurfaceTexturePair {
  readonly map: Texture;
  readonly bumpMap: Texture;
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
  readonly visibleFireflies: number;
  readonly visibleSunbeams: number;
  readonly visibleBirds: number;
  readonly visibleMistClusters: number;
  readonly visibleFoamClusters: number;
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

function proceduralHeightTexture(
  seed: number,
  repeatX: number,
  repeatY: number,
): DataTexture {
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const macro = periodicNoise(x, y, size, 6, seed);
      const meso = periodicNoise(x, y, size, 19, seed ^ 0x51ed_270b);
      const grain = hashedUnit(x, y, seed ^ 0x75d9_3cbb);
      const height = Math.max(0, Math.min(1, macro * 0.52 + meso * 0.36 + grain * 0.12));
      const value = Math.round(height * 255);
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function proceduralWaterfallMaskTexture(seed: number): DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const longitudinal = y / size;
      const warp = periodicNoise(x, y, size, 9, seed) * 2 - 1;
      const broad = Math.abs(Math.sin(x * 0.21 + warp * 2.2 + longitudinal * 5.4));
      const fine = Math.abs(Math.sin(x * 0.57 - warp * 1.6 + longitudinal * 11.3));
      const breakup = periodicNoise(x, y, size, 23, seed ^ 0x51ed_270b);
      const stream = Math.pow(Math.max(
        broad * 0.48 + fine * 0.22 + breakup * 0.3 - 0.08,
        0,
      ) / 0.92, 1.08);
      const holes = breakup < 0.18 ? 0.32 + breakup / 0.18 * 0.68 : 1;
      const aeration = 0.8 + Math.sin(longitudinal * Math.PI) * 0.2;
      const value = Math.round(Math.max(0.12, Math.min(1, stream * holes * aeration)) * 255);
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(1.15, 1.8);
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function proceduralMistMaskTexture(seed: number): DataTexture {
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const normalizedX = x / (size - 1) * 2 - 1;
      const normalizedY = y / (size - 1) * 2 - 1;
      const radial = Math.max(0, 1 - Math.hypot(normalizedX, normalizedY * 0.82));
      const billow = periodicNoise(x, y, size, 7, seed) * 0.64
        + periodicNoise(x, y, size, 17, seed ^ 0x6d82_3f19) * 0.36;
      const value = Math.round(Math.max(0, Math.min(1, radial * radial * (0.58 + billow * 0.72))) * 255);
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.colorSpace = NoColorSpace;
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
  return Math.sin(z * 0.16) * 1.12
    + Math.sin(z * 0.052) * 0.58
    + Math.sin(z * 0.39 + 0.7) * 0.16;
}

function riverHalfWidth(z: number, seed: number): number {
  return 2.08
    + Math.sin(z * 0.23 + seed * 0.000_013) * 0.42
    + Math.sin(z * 0.51 - seed * 0.000_019) * 0.23
    + Math.sin(z * 0.11 + seed * 0.000_007) * 0.12;
}

function irregularPlungePoolGeometry(seed: number): BufferGeometry {
  const segments = 64;
  const positions: number[] = [0, 0, 0];
  const uvs: number[] = [0.5, 0.5];
  const indices: number[] = [];
  for (let segment = 0; segment <= segments; segment += 1) {
    const angle = segment / segments * TAU;
    const broad = Math.sin(angle * 3 + seed * 0.000_011) * 0.1
      + Math.sin(angle * 7 - seed * 0.000_019) * 0.045;
    const granular = (hashedUnit(segment % segments, 0, seed ^ 0x31b7_4a8d) - 0.5) * 0.055;
    const radius = 1 + broad + granular;
    const x = Math.cos(angle) * 4.05 * radius;
    const z = Math.sin(angle) * 2.62 * radius;
    positions.push(x, Math.sin(angle * 4 + seed * 0.000_017) * 0.018, z);
    uvs.push(0.5 + x / 8.7, 0.5 + z / 5.7);
    if (segment < segments) indices.push(0, segment + 1, segment + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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
  const geometry = new IcosahedronGeometry(1, 4);
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

function organicCrownGeometry(seed: number): SphereGeometry {
  const geometry = new SphereGeometry(1, 24, 16);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const longitude = Math.round((Math.atan2(z, x) + Math.PI) * 2_048);
    const latitude = Math.round((y + 1.25) * 3_072);
    const angle = Math.atan2(z, x);
    const broad = Math.sin(angle * 3 + seed * 0.000_009) * 0.12
      + Math.cos(angle * 5 - y * 2.8 + seed * 0.000_017) * 0.07;
    const variation = 0.74 + broad + hashedUnit(longitude, latitude, seed) * 0.31;
    const vertical = 0.88 + Math.max(0, y) * 0.16;
    const crownLean = Math.max(0, y) * Math.sin(seed * 0.000_023) * 0.14;
    positions.setXYZ(
      index,
      x * variation + crownLean,
      y * variation * vertical,
      z * variation * (0.88 + hashedUnit(latitude, longitude, seed ^ 0x41c6_ce57) * 0.24),
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function forestLayerMassGeometry(seed: number): IcosahedronGeometry {
  const geometry = new IcosahedronGeometry(1, 1);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const longitude = Math.round((Math.atan2(z, x) + Math.PI) * 1_024);
    const latitude = Math.round((y + 1.2) * 1_536);
    const variation = 0.82
      + hashedUnit(longitude, latitude, seed) * 0.26
      + Math.sin(Math.atan2(z, x) * 4 + seed * 0.000_017) * 0.07;
    positions.setXYZ(
      index,
      x * variation,
      y * variation * (0.76 + Math.max(0, y) * 0.16),
      z * variation * (0.9 + hashedUnit(latitude, longitude, seed ^ 0x51a7_2bc3) * 0.18),
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function organicTrunkGeometry(seed: number): CylinderGeometry {
  const geometry = new CylinderGeometry(0.1, 0.28, 1, 20, 9);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const progress = Math.max(0, Math.min(1, y + 0.5));
    const rootFlare = 1 + Math.pow(1 - progress, 4) * 0.52;
    const bendX = Math.sin(progress * 2.8 + seed * 0.000_017) * progress * 0.055;
    const bendZ = Math.cos(progress * 2.25 - seed * 0.000_023) * progress * 0.045;
    const barkRipple = 0.94
      + Math.sin(Math.atan2(z, x) * 5 + progress * 9.2 + seed * 0.000_011) * 0.045;
    positions.setXYZ(
      index,
      x * rootFlare * barkRipple + bendX,
      y,
      z * rootFlare * barkRipple + bendZ,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function organicBranchGeometry(seed: number): CylinderGeometry {
  const geometry = new CylinderGeometry(0.035, 0.09, 1, 12, 6);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const progress = Math.max(0, Math.min(1, y + 0.5));
    const bendX = Math.sin(progress * 2.35 + seed * 0.000_019) * progress * 0.13;
    const bendZ = Math.cos(progress * 2.7 - seed * 0.000_013) * progress * 0.09;
    const taperRipple = 0.94 + Math.sin(progress * 8.2 + Math.atan2(z, x) * 3) * 0.045;
    positions.setXYZ(index, x * taperRipple + bendX, y, z * taperRipple + bendZ);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function sunbeamRibbonGeometry(seed: number): BufferGeometry {
  const rows = 8;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    const t = row / rows;
    const y = 6 - t * 12;
    const width = 0.2 + t * 0.96 + Math.sin(t * 4.7 + seed * 0.000_017) * 0.08;
    const drift = Math.sin(t * 3.4 + seed * 0.000_011) * 0.18;
    positions.push(
      drift - width * 0.5, y, Math.sin(t * 5.2) * 0.035,
      drift + width * 0.5, y, -Math.sin(t * 5.2) * 0.035,
    );
    uvs.push(0, t, 1, t);
  }
  for (let row = 0; row < rows; row += 1) {
    const left = row * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    indices.push(left, nextLeft, right, right, nextLeft, nextRight);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function cloudBillboardGeometry(seed: number): BufferGeometry {
  const perimeterSegments = 12;
  const positions: number[] = [0, 0, 0];
  const uvs: number[] = [0.5, 0.5];
  const indices: number[] = [];
  const phase = hashedUnit(0, 0, seed) * TAU;
  for (let segment = 0; segment < perimeterSegments; segment += 1) {
    const angle = segment / perimeterSegments * TAU;
    const radialNoise = 0.88
      + Math.sin(angle * 3 + phase) * 0.13
      + hashedUnit(segment, 1, seed ^ 0x4c17_a2d9) * 0.14;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    positions.push(
      cos * 1.45 * radialNoise,
      sin * 0.72 * radialNoise + Math.sin(angle * 2 + phase) * 0.07,
      Math.sin(angle * 2.4 - phase) * 0.045,
    );
    uvs.push(0.5 + cos * 0.49, 0.5 + sin * 0.49);
  }
  for (let segment = 0; segment < perimeterSegments; segment += 1) {
    indices.push(0, segment + 1, (segment + 1) % perimeterSegments + 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function grassTuftGeometry(): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let blade = 0; blade < 5; blade += 1) {
    const angle = (blade / 5) * Math.PI;
    const sideX = Math.cos(angle) * 0.17;
    const sideZ = Math.sin(angle) * 0.17;
    const leanX = Math.sin(angle + 0.7) * (0.16 + blade * 0.012);
    const leanZ = Math.cos(angle + 0.7) * (0.16 + blade * 0.012);
    positions.push(
      -sideX, 0, -sideZ,
      sideX, 0, sideZ,
      leanX, 0.94 + (blade % 3) * 0.12, leanZ,
    );
    uvs.push(0, 0, 1, 0, 0.5, 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

function waterfallFoamRibbonGeometry(seed: number): BufferGeometry {
  const segments = 20;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let segment = 0; segment <= segments; segment += 1) {
    const t = segment / segments;
    const angle = -0.78 + t * 1.56;
    const noise = hashedUnit(segment, 0, seed) - 0.5;
    const innerRadius = 0.66 + Math.sin(t * Math.PI) * 0.07 + noise * 0.05;
    const width = 0.13 + hashedUnit(segment, 1, seed ^ 0x59b4_1d77) * 0.11;
    const height = Math.sin(t * Math.PI * 2 + seed * 0.000_021) * 0.025;
    positions.push(
      Math.sin(angle) * innerRadius,
      height,
      Math.cos(angle) * innerRadius,
      Math.sin(angle) * (innerRadius + width),
      height + 0.008,
      Math.cos(angle) * (innerRadius + width),
    );
    uvs.push(t, 0, t, 1);
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const inner = segment * 2;
    const outer = inner + 1;
    const nextInner = inner + 2;
    const nextOuter = inner + 3;
    indices.push(inner, nextInner, outer, outer, nextInner, nextOuter);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function waterfallMistWispGeometry(): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let plane = 0; plane < 4; plane += 1) {
    const angle = plane / 4 * Math.PI;
    const sideX = Math.cos(angle) * 0.38;
    const sideZ = Math.sin(angle) * 0.38;
    const leanX = Math.sin(angle + 0.44) * 0.22;
    const leanZ = Math.cos(angle + 0.44) * 0.22;
    const height = 1.2 + plane * 0.08;
    const offset = positions.length / 3;
    positions.push(
      -sideX, 0, -sideZ,
      sideX, 0, sideZ,
      -sideX + leanX, height, -sideZ + leanZ,
      sideX + leanX, height, sideZ + leanZ,
    );
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function waterfallImpactPlumeGeometry(seed: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let plane = 0; plane < 5; plane += 1) {
    const angle = plane / 5 * Math.PI + (hashedUnit(plane, 0, seed) - 0.5) * 0.26;
    const sideX = Math.cos(angle) * (0.42 + hashedUnit(plane, 1, seed) * 0.18);
    const sideZ = Math.sin(angle) * (0.42 + hashedUnit(plane, 2, seed) * 0.18);
    const leanX = Math.sin(angle + 0.42) * (0.25 + hashedUnit(plane, 3, seed) * 0.2);
    const leanZ = Math.cos(angle + 0.42) * (0.25 + hashedUnit(plane, 4, seed) * 0.2);
    const crown = 0.92 + hashedUnit(plane, 5, seed) * 0.68;
    const offset = positions.length / 3;
    positions.push(
      -sideX, 0, -sideZ,
      sideX, 0, sideZ,
      -sideX + leanX, crown, -sideZ + leanZ,
      sideX + leanX, crown, sideZ + leanZ,
    );
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function waterfallOutflowRibbonGeometry(
  seed: number,
  length: number,
  width: number,
): BufferGeometry {
  const segments = 18;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let segment = 0; segment <= segments; segment += 1) {
    const t = segment / segments;
    const centerX = Math.sin(t * 4.7 + seed * 0.000_013) * width * 0.22;
    const centerZ = t * length;
    const ribbonWidth = width * (
      0.42
      + t * 0.68
      + Math.sin(t * 7.6 + seed * 0.000_021) * 0.09
    );
    const breakup = (hashedUnit(segment, 0, seed) - 0.5) * width * 0.08;
    const height = Math.sin(t * 5.4 + seed * 0.000_019) * 0.012;
    positions.push(
      centerX - ribbonWidth * 0.5 + breakup, height, centerZ,
      centerX + ribbonWidth * 0.5 - breakup, height + 0.006, centerZ,
    );
    uvs.push(t, 0, t, 1);
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const left = segment * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    indices.push(left, nextLeft, right, right, nextLeft, nextRight);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function waterfallLipRibbonGeometry(seed: number, width: number): BufferGeometry {
  const segments = 12;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let segment = 0; segment <= segments; segment += 1) {
    const t = segment / segments;
    const x = (t - 0.5) * width;
    const lift = Math.sin(t * Math.PI) * 0.045;
    const breakup = (hashedUnit(segment, 0, seed) - 0.5) * 0.035;
    const depth = (hashedUnit(segment, 1, seed ^ 0x3c71_a249) - 0.5) * 0.025;
    positions.push(
      x, lift + breakup, depth,
      x, lift - 0.09 - breakup * 0.35, depth + 0.018,
    );
    uvs.push(t, 0, t, 1);
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const top = segment * 2;
    const bottom = top + 1;
    const nextTop = top + 2;
    const nextBottom = bottom + 2;
    indices.push(top, bottom, nextTop, nextTop, bottom, nextBottom);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function waterfallCliffFaceGeometry(seed: number): PlaneGeometry {
  const geometry = new PlaneGeometry(7.4, 8.2, 28, 30);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const normalizedX = x / 3.7;
    const normalizedY = (y + 4.1) / 8.2;
    const edge = Math.pow(Math.abs(normalizedX), 4);
    const ledge = Math.sin(normalizedY * 8.4 + seed * 0.000_019) * 0.16;
    const crag = (hashedUnit(
      Math.round((normalizedX + 1) * 4_096),
      Math.round(normalizedY * 4_096),
      seed,
    ) - 0.5) * 0.22;
    positions.setXYZ(
      index,
      x + Math.sign(x) * edge * (0.12 + crag * 0.4),
      y + crag * 0.12,
      ledge + crag + edge * 0.18,
    );
  }
  positions.needsUpdate = true;
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

function taperedWaterfallStreamGeometry(
  curve: CatmullRomCurve3,
  radius: number,
  phase: number,
): TubeGeometry {
  const tubularSegments = 48;
  const radialSegments = 10;
  const geometry = new TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
  const positions = geometry.attributes.position;
  const center = new Vector3();
  const verticesPerRing = radialSegments + 1;
  for (let ring = 0; ring <= tubularSegments; ring += 1) {
    const t = ring / tubularSegments;
    curve.getPointAt(t, center);
    const lowerFlare = Math.max(0, (t - 0.76) / 0.24);
    const taper = 0.62
      + Math.pow(1 - t, 1.35) * 0.38
      + Math.pow(lowerFlare, 1.7) * 0.54;
    const pulse = 1 + Math.sin(t * 8.5 + phase) * 0.055;
    const width = taper * pulse;
    const depth = taper * (0.78 + Math.cos(t * 6.8 + phase * 1.3) * 0.065);
    for (let radial = 0; radial < verticesPerRing; radial += 1) {
      const index = ring * verticesPerRing + radial;
      const offsetX = positions.getX(index) - center.x;
      const offsetY = positions.getY(index) - center.y;
      const offsetZ = positions.getZ(index) - center.z;
      positions.setXYZ(
        index,
        center.x + offsetX * width,
        center.y + offsetY * taper,
        center.z + offsetZ * depth,
      );
    }
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function waterfallVolumeGeometry(
  seed: number,
  centerX: number,
  width: number,
  crest: number,
  impact: number,
  depth: number,
): BufferGeometry {
  const columns = 6;
  const rows = 24;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const verticesPerRow = columns + 1;
  const verticesPerFace = (rows + 1) * verticesPerRow;
  const breakPhase = 0.28 + hashedUnit(0, 0, seed ^ 0x6c31_a957) * 0.36;
  const breakDirection = hashedUnit(0, 1, seed ^ 0x9a67_3d21) < 0.5 ? -1 : 1;
  const acceleration = 1.04 + hashedUnit(0, 2, seed ^ 0x2f91_c47b) * 0.38;
  const breakReach = width * (0.16 + hashedUnit(0, 3, seed ^ 0xd4a7_18c3) * 0.22);
  const depthReach = 0.38 + hashedUnit(0, 4, seed ^ 0x51e8_b62d) * 0.44;
  for (let face = 0; face < 2; face += 1) {
    for (let row = 0; row <= rows; row += 1) {
      const t = row / rows;
      const fall = Math.pow(t, acceleration);
      const breakDelta = t - breakPhase;
      const breakProgress = Math.max(0, Math.min(1, breakDelta / 0.2));
      const ledgeDistance = breakDelta / 0.075;
      const ledgeKick = Math.exp(-(ledgeDistance * ledgeDistance));
      const drift = Math.sin(t * 4.6 + seed * 0.000_013) * width * 0.11
        + Math.sin(t * 11.3 + seed * 0.000_031) * width * 0.035
        + breakDirection * breakReach * breakProgress
        + Math.sin(breakProgress * 5.2 + seed * 0.000_009) * width * 0.045 * breakProgress;
      const rowWidth = width * (
        0.64
        + t * 0.24
        + Math.sin(t * 6.3 + seed * 0.000_017) * 0.12
        + (hashedUnit(row, 0, seed ^ 0x76d4_2b91) - 0.5) * 0.08
      ) * (1 + ledgeKick * 0.34 - breakProgress * 0.1);
      const leftEdge = centerX + drift - rowWidth * 0.5
        + (hashedUnit(row, 1, seed ^ 0x1f62_83ad) - 0.5) * width * 0.13;
      const rightEdge = centerX + drift + rowWidth * 0.5
        + (hashedUnit(row, 2, seed ^ 0x9a34_6cb7) - 0.5) * width * 0.13;
      const y = crest + (impact - crest) * fall;
      const thickness = 0.08
        + Math.sin(t * Math.PI) * 0.11
        + t * 0.035
        + ledgeKick * 0.11
        + breakProgress * 0.035;
      for (let column = 0; column <= columns; column += 1) {
        const columnT = column / columns;
        const across = columnT * 2 - 1;
        const x = leftEdge + (rightEdge - leftEdge) * columnT;
        const rockFollow = Math.sin(t * 7.8 + across * 2.9 + seed * 0.000_019) * 0.105;
        const turbulence = (hashedUnit(row, column, seed ^ 0x6af1_28c3) - 0.5) * 0.07;
        const frontZ = depth
          + t * 0.28
          + breakProgress * depthReach
          + ledgeKick * 0.32
          + rockFollow
          + turbulence
          + across * across * 0.055;
        const z = frontZ - face * thickness;
        positions.push(x, y, z);
        uvs.push(columnT, t);
      }
    }
  }
  for (let face = 0; face < 2; face += 1) {
    const offset = face * verticesPerFace;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const topLeft = offset + row * verticesPerRow + column;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + verticesPerRow;
        const bottomRight = bottomLeft + 1;
        if (face === 0) {
          indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
        } else {
          indices.push(topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft);
        }
      }
    }
  }
  for (let row = 0; row < rows; row += 1) {
    const frontLeft = row * verticesPerRow;
    const nextFrontLeft = frontLeft + verticesPerRow;
    const backLeft = frontLeft + verticesPerFace;
    const nextBackLeft = nextFrontLeft + verticesPerFace;
    indices.push(frontLeft, backLeft, nextFrontLeft, nextFrontLeft, backLeft, nextBackLeft);
    const frontRight = frontLeft + columns;
    const nextFrontRight = nextFrontLeft + columns;
    const backRight = frontRight + verticesPerFace;
    const nextBackRight = nextFrontRight + verticesPerFace;
    indices.push(frontRight, nextFrontRight, backRight, nextFrontRight, nextBackRight, backRight);
  }
  for (const row of [0, rows]) {
    for (let column = 0; column < columns; column += 1) {
      const frontLeft = row * verticesPerRow + column;
      const frontRight = frontLeft + 1;
      const backLeft = frontLeft + verticesPerFace;
      const backRight = frontRight + verticesPerFace;
      if (row === 0) {
        indices.push(frontLeft, frontRight, backLeft, frontRight, backRight, backLeft);
      } else {
        indices.push(frontLeft, backLeft, frontRight, frontRight, backLeft, backRight);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function waterfallWetTrailGeometry(
  seed: number,
  centerX: number,
  width: number,
  crest: number,
  impact: number,
  depth: number,
): BufferGeometry {
  const rows = 16;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    const t = row / rows;
    const drift = Math.sin(t * 5.7 + seed * 0.000_017) * width * 0.08;
    const trailWidth = width * (0.86 + t * 0.19 + Math.sin(t * 8.2) * 0.06);
    const y = crest + (impact - crest) * t;
    const shade = 0.28 - t * 0.1;
    positions.push(
      centerX + drift - trailWidth * 0.5, y, depth + t * 0.46,
      centerX + drift + trailWidth * 0.5, y, depth + t * 0.46,
    );
    uvs.push(0, t, 1, t);
    colors.push(
      shade * 0.62, shade * 0.86, shade * 0.76,
      shade * 0.62, shade * 0.86, shade * 0.76,
    );
  }
  for (let row = 0; row < rows; row += 1) {
    const left = row * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    indices.push(left, nextLeft, right, right, nextLeft, nextRight);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function sunsetSkyGeometry(): SphereGeometry {
  const radius = 48;
  const geometry = new SphereGeometry(radius, 32, 20);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const low = new Color(0x0a1612);
  const horizon = new Color(0x52675b);
  const high = new Color(0x132c43);
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
  readonly #treeLeafCards: InstancedMesh;
  readonly #treeBranches: InstancedMesh;
  readonly #treeShadows: InstancedMesh;
  readonly #foregroundCanopy: InstancedMesh;
  readonly #midUnderstory: InstancedMesh;
  readonly #backgroundCanopy: InstancedMesh;
  readonly #grass: InstancedMesh;
  readonly #flowers: InstancedMesh;
  readonly #fireflies: InstancedMesh;
  readonly #sunbeams: Mesh[] = [];
  readonly #birds: InstancedMesh;
  readonly #mist: InstancedMesh;
  readonly #foam: InstancedMesh;
  readonly #clouds: InstancedMesh;
  readonly #cloudLobes: readonly InstancedMesh[];
  readonly #riverTexture: Texture;
  readonly #pulseRing: Mesh;
  readonly #materials: HeroOwnedMaterial[] = [];
  readonly #geometries: HeroOwnedGeometry[] = [];
  readonly #textures: HeroOwnedTexture[] = [];
  readonly #surfaceTextureLoads: HeroSurfaceTextureLoad[] = [];
  readonly #originalBackground: Scene["background"];
  readonly #originalFog: Scene["fog"];
  readonly #backgroundColor = new Color(0x162b27);
  readonly #aerialFog = new FogExp2(0x344940, 0.019);
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
  #initializePromise: Promise<void> | null = null;
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
      0x1b2e20,
      0x5d7446,
      7,
      9,
    ));
    groundTexture.name = "hero-b:forest-ground-texture";
    const groundHeightTexture = this.#ownTexture(proceduralHeightTexture(
      seed ^ 0x154d_7b23,
      7,
      9,
    ));
    groundHeightTexture.name = "hero-b:forest-ground-linear-height-texture";
    const concreteTexture = this.#ownTexture(proceduralTexture(
      seed ^ 0x9e37_79b9,
      0x303236,
      0x83817a,
      5,
      5,
    ));
    concreteTexture.name = "hero-b:weathered-concrete-texture";
    const concreteHeightTexture = this.#ownTexture(proceduralHeightTexture(
      seed ^ 0x6c31_a9f5,
      5,
      5,
    ));
    concreteHeightTexture.name = "hero-b:concrete-linear-height-texture";
    const riverTexture = this.#riverTexture = this.#ownTexture(proceduralTexture(
      seed ^ 0x75d9_3cbb,
      0x1d6670,
      0x8fd5c3,
      3,
      12,
    ));
    riverTexture.name = "hero-b:river-flow-texture";
    const riverHeightTexture = this.#ownTexture(proceduralHeightTexture(
      seed ^ 0x6f2a_c831,
      3,
      12,
    ));
    riverHeightTexture.name = "hero-b:river-linear-height-texture";
    const waterfallMaskTexture = this.#ownTexture(proceduralWaterfallMaskTexture(
      seed ^ 0x3b94_d1e7,
    ));
    waterfallMaskTexture.name = "hero-b:waterfall-linear-alpha-mask";
    const mistMaskTexture = this.#ownTexture(proceduralMistMaskTexture(
      seed ^ 0x6f25_c831,
    ));
    mistMaskTexture.name = "hero-b:waterfall-mist-linear-alpha-mask";
    const wetRockSurface = this.#surfaceTexturePair(
      "hero-b:wet-basalt-surface-texture",
      "/assets/gfx/hero-b/wet-basalt-v1.webp",
      1.45,
      1.7,
    );
    const foliageSurface = this.#surfaceTexturePair(
      "hero-b:photoreal-foliage-surface-texture",
      "/assets/gfx/hero-b/forest-foliage-v1.webp",
      1.7,
      1.7,
    );
    const barkSurface = this.#surfaceTexturePair(
      "hero-b:dark-bark-surface-texture",
      "/assets/gfx/hero-b/dark-bark-v1.webp",
      2,
      4,
    );
    const leafClusterSurface = this.#surfaceTexturePair(
      "hero-b:leaf-cluster-cutout-texture",
      "/assets/gfx/hero-b/leaf-cluster-v1.webp",
      1,
      1,
    );
    const waterfallFlowSurface = this.#surfaceTexturePair(
      "hero-b:photoreal-waterfall-flow-texture",
      "/assets/gfx/hero-b/waterfall-flow-v1.webp",
      1.12,
      1.82,
    );

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

    this.#ambient = new AmbientLight(0xb9c8b8, 0.25);
    this.#ambient.name = "hero-b:soft-ambient";
    this.#hemisphere = new HemisphereLight(0xa9cbd0, 0x0c1b0f, 0.86);
    this.#hemisphere.name = "hero-b:sunset-hemisphere";
    this.#sun = new DirectionalLight(0xffd6a8, 4.2);
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
    ground.bumpMap = groundHeightTexture;
    ground.bumpScale = 0.18;
    const rock = this.#ownMaterial(standardMaterial(0xffffff, 0.92));
    rock.map = wetRockSurface.map;
    rock.bumpMap = wetRockSurface.bumpMap;
    rock.bumpScale = 0.085;
    const cliffRock = this.#ownMaterial(standardMaterial(0x303a32, 0.96));
    cliffRock.map = wetRockSurface.map;
    cliffRock.bumpMap = wetRockSurface.bumpMap;
    cliffRock.bumpScale = 0.12;
    const wetCliffRock = this.#ownMaterial(physicalMaterial(0xffffff, 1, 0.42, 1.34));
    wetCliffRock.map = wetRockSurface.map;
    wetCliffRock.bumpMap = wetRockSurface.bumpMap;
    wetCliffRock.bumpScale = 0.15;
    wetCliffRock.clearcoat = 0.72;
    wetCliffRock.clearcoatRoughness = 0.24;
    const bark = this.#ownMaterial(standardMaterial(0x594735, 0.88));
    bark.map = barkSurface.map;
    bark.bumpMap = barkSurface.bumpMap;
    bark.bumpScale = 0.12;
    const leaf = this.#ownMaterial(standardMaterial(0xffffff, 0.78));
    leaf.map = foliageSurface.map;
    leaf.bumpMap = foliageSurface.bumpMap;
    leaf.bumpScale = 0.045;
    const grassMaterial = this.#ownMaterial(standardMaterial(0xd6e0cd, 0.84));
    grassMaterial.map = foliageSurface.map;
    grassMaterial.bumpMap = foliageSurface.bumpMap;
    grassMaterial.bumpScale = 0.05;
    grassMaterial.side = DoubleSide;
    const leafCardMaterial = this.#ownMaterial(standardMaterial(0xffffff, 0.78));
    leafCardMaterial.map = leafClusterSurface.map;
    leafCardMaterial.bumpMap = leafClusterSurface.bumpMap;
    leafCardMaterial.bumpScale = 0.018;
    leafCardMaterial.alphaTest = 0.28;
    leafCardMaterial.side = DoubleSide;
    const canopyMassMaterial = this.#ownMaterial(new MeshBasicNodeMaterial());
    canopyMassMaterial.color.setHex(0xc4d1c5);
    canopyMassMaterial.map = foliageSurface.map;
    canopyMassMaterial.toneMapped = true;
    const flowerMaterial = this.#ownMaterial(standardMaterial(0xd5a66d, 0.68));
    flowerMaterial.emissive.setHex(0x2e1209);
    flowerMaterial.emissiveIntensity = 0.18;
    const birdMaterial = this.#ownMaterial(standardMaterial(0x342d2a, 0.66));
    birdMaterial.side = DoubleSide;
    const concrete = this.#ownMaterial(standardMaterial(0xffffff, 0.86, 0.06));
    concrete.map = concreteTexture;
    concrete.bumpMap = concreteHeightTexture;
    concrete.bumpScale = 0.1;
    const metal = this.#ownMaterial(standardMaterial(0x51545a, 0.58, 0.68));
    const moss = this.#ownMaterial(standardMaterial(0x48643b, 0.91));
    moss.map = foliageSurface.map;
    moss.bumpMap = foliageSurface.bumpMap;
    moss.bumpScale = 0.055;
    const glass = this.#ownMaterial(physicalMaterial(0x7f9d9b, 0.34, 0.22, 1.45));
    glass.thickness = 0.14;
    glass.clearcoat = 0.7;
    const river = this.#ownMaterial(physicalMaterial(0x4b8b83, 0.78, 0.16, 1.333));
    river.map = riverTexture;
    river.bumpMap = riverHeightTexture;
    river.bumpScale = 0.055;
    river.clearcoat = 1;
    river.clearcoatRoughness = 0.12;
    river.iridescence = 0.1;
    river.iridescenceIOR = 1.28;
    const waterfallMain = this.#ownMaterial(physicalMaterial(0xa8d0cc, 0.5, 0.16, 1.333));
    waterfallMain.emissive.setHex(0x0a3e3c);
    waterfallMain.emissiveIntensity = 0.12;
    const waterfallMid = this.#ownMaterial(physicalMaterial(0x7fa9a6, 0.38, 0.22, 1.333));
    waterfallMid.emissive.setHex(0x082b2d);
    waterfallMid.emissiveIntensity = 0.08;
    const waterfallVeil = this.#ownMaterial(physicalMaterial(0xdceae6, 0.22, 0.25, 1.333));
    waterfallVeil.emissive.setHex(0x123a38);
    waterfallVeil.emissiveIntensity = 0.055;
    const waterfallMaterials = Object.freeze([waterfallMid, waterfallMain, waterfallVeil]);
    for (const waterfall of waterfallMaterials) {
      waterfall.bumpMap = waterfallFlowSurface.bumpMap;
      waterfall.bumpScale = waterfall === waterfallMain ? 0.075 : 0.052;
      waterfall.alphaMap = waterfallMaskTexture;
      waterfall.alphaTest = waterfall === waterfallMain
        ? 0.055
        : waterfall === waterfallMid ? 0.095 : 0.16;
      waterfall.clearcoat = 1;
      waterfall.clearcoatRoughness = 0.08;
      waterfall.iridescence = 0.08;
      waterfall.iridescenceIOR = 1.27;
    }
    const mistMaterial = this.#ownMaterial(additiveMaterial(0xd8eee8, 0.25));
    const impactPlumeMaterial = this.#ownMaterial(new MeshBasicNodeMaterial());
    impactPlumeMaterial.color.setHex(0xeaf7f1);
    impactPlumeMaterial.transparent = true;
    impactPlumeMaterial.opacity = 0.32;
    impactPlumeMaterial.depthWrite = false;
    impactPlumeMaterial.side = DoubleSide;
    impactPlumeMaterial.toneMapped = false;
    const outflowMaterial = this.#ownMaterial(additiveMaterial(0xe7f7ef, 0.28));
    mistMaterial.alphaMap = mistMaskTexture;
    impactPlumeMaterial.alphaMap = mistMaskTexture;
    outflowMaterial.alphaMap = mistMaskTexture;
    const foamMaterial = this.#ownMaterial(physicalMaterial(0xf3f8f4, 0.44, 0.24, 1.333));
    foamMaterial.clearcoat = 0.72;
    foamMaterial.clearcoatRoughness = 0.18;
    const wetTrailMaterial = this.#ownMaterial(physicalMaterial(0x6e8980, 0.82, 0.24, 1.34));
    wetTrailMaterial.map = wetRockSurface.map;
    wetTrailMaterial.bumpMap = wetRockSurface.bumpMap;
    wetTrailMaterial.bumpScale = 0.075;
    wetTrailMaterial.vertexColors = true;
    wetTrailMaterial.clearcoat = 0.92;
    wetTrailMaterial.clearcoatRoughness = 0.16;
    const cloudMaterial = this.#ownMaterial(new MeshBasicNodeMaterial());
    cloudMaterial.color.setHex(0x9bafa7);
    cloudMaterial.transparent = true;
    cloudMaterial.opacity = 0.17;
    cloudMaterial.depthWrite = false;
    cloudMaterial.side = DoubleSide;
    cloudMaterial.alphaMap = mistMaskTexture;
    cloudMaterial.toneMapped = true;
    const sunbeamMaterial = this.#ownMaterial(additiveMaterial(0xffe4ad, 0.046));
    sunbeamMaterial.alphaMap = mistMaskTexture;
    const fireflyMaterial = this.#ownMaterial(additiveMaterial(0xffdc7a, 0.76));
    const contactShadowMaterial = this.#ownMaterial(new MeshBasicNodeMaterial());
    contactShadowMaterial.color.setHex(0x020604);
    contactShadowMaterial.transparent = true;
    contactShadowMaterial.opacity = 0.28;
    contactShadowMaterial.depthWrite = false;
    contactShadowMaterial.side = DoubleSide;
    contactShadowMaterial.toneMapped = false;
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
      this.#ownGeometry(new SphereGeometry(0.72, 20, 14)),
      this.#ownMaterial(additiveMaterial(0xffd58a, 0.58)),
    );
    sunDisc.name = "hero-b:sun-disc";
    sunDisc.position.set(-13, 8.4, -32);
    this.#skyRoot.add(sunDisc);

    for (let beamIndex = 0; beamIndex < 4; beamIndex += 1) {
      const sunbeamGeometry = this.#ownGeometry(sunbeamRibbonGeometry(
        seed ^ (0x56c1_3fa7 + beamIndex * 0x1f31),
      ));
      sunbeamGeometry.name = `hero-b:sun-aligned-irregular-beam-geometry:${beamIndex}`;
      const beam = new Mesh(sunbeamGeometry, sunbeamMaterial);
      beam.name = `hero-b:forest-sunbeam:${beamIndex}`;
      const sunAngle = 0.14 + beamIndex * 0.17;
      const verticalScale = 1.14 + beamIndex * 0.07;
      beam.position.set(
        -13 + Math.sin(sunAngle) * 6 * verticalScale,
        4.8 - beamIndex * 0.2,
        -10.4 - beamIndex * 2.7,
      );
      beam.rotation.set(0.02 + beamIndex * 0.008, 0, sunAngle);
      beam.scale.set(0.82 + beamIndex * 0.17, verticalScale, 1);
      beam.renderOrder = -1;
      this.#sunbeams.push(beam);
      this.#forestRoot.add(beam);
    }

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
      const widthScale = riverHalfWidth(z, seed) / 2.6;
      const bankWeight = Math.pow(Math.abs(x) / 2.6, 3);
      const bankBreakup = Math.sin(z * 0.72 + Math.sign(x) * 1.4 + seed * 0.000_017)
        * bankWeight * 0.24;
      riverPositions.setX(index, x * widthScale + riverCenter(z) + bankBreakup);
      riverPositions.setZ(
        index,
        Math.sin(z * 0.24) * 0.04 + Math.sin(z * 0.61 + x * 0.35) * 0.018,
      );
    }
    riverPositions.needsUpdate = true;
    riverGeometry.computeVertexNormals();
    const riverMesh = new Mesh(riverGeometry, river);
    riverMesh.name = "hero-b:wide-river";
    riverMesh.rotation.x = -Math.PI / 2;
    riverMesh.position.set(0, -1.06, -5.5);
    riverMesh.renderOrder = 2;
    this.#waterRoot.add(riverMesh);

    const plungePool = new Mesh(
      this.#ownGeometry(irregularPlungePoolGeometry(seed ^ 0x8f37_1ca9)),
      river,
    );
    plungePool.name = "hero-b:waterfall-plunge-pool";
    plungePool.position.set(0, -1.12, -17.05);
    plungePool.renderOrder = 2;
    this.#waterfallRoot.add(plungePool);

    const upperRiver = new Mesh(
      this.#ownGeometry(new PlaneGeometry(5.8, 7.4, 12, 18)),
      river,
    );
    upperRiver.name = "hero-b:upper-feeder-river";
    upperRiver.rotation.x = -Math.PI / 2;
    upperRiver.position.set(-0.05, 5.58, -21.42);
    upperRiver.renderOrder = 2;
    this.#waterfallRoot.add(upperRiver);

    const riverLipCurve = new CatmullRomCurve3([
      new Vector3(-2.9, 5.62, -18.02),
      new Vector3(-1.76, 5.68, -17.91),
      new Vector3(-0.62, 5.6, -18.12),
      new Vector3(0.52, 5.66, -17.88),
      new Vector3(1.72, 5.59, -18.08),
      new Vector3(2.88, 5.64, -17.94),
    ]);
    const riverLip = new Mesh(
      this.#ownGeometry(new TubeGeometry(riverLipCurve, 48, 0.045, 8, false)),
      foamMaterial,
    );
    riverLip.name = "hero-b:waterfall-river-lip-foam";
    riverLip.renderOrder = 4;
    this.#waterfallRoot.add(riverLip);

    const wetCliffFace = new Mesh(
      this.#ownGeometry(waterfallCliffFaceGeometry(seed ^ 0x913e_5b72)),
      wetCliffRock,
    );
    wetCliffFace.name = "hero-b:wet-waterfall-cliff-face";
    wetCliffFace.position.set(0, 2.22, -18.62);
    wetCliffFace.renderOrder = 0;
    this.#waterfallRoot.add(wetCliffFace);

    const waterfallVolumes = Object.freeze([
      Object.freeze({ centerX: -2.18, width: 0.68, crest: 5.42, impact: -0.72, depth: -18.34 }),
      Object.freeze({ centerX: -0.98, width: 1.08, crest: 5.68, impact: -1.34, depth: -17.82 }),
      Object.freeze({ centerX: 0.12, width: 0.5, crest: 4.92, impact: -0.38, depth: -18.42 }),
      Object.freeze({ centerX: 1.02, width: 0.9, crest: 5.58, impact: -1.36, depth: -17.74 }),
      Object.freeze({ centerX: 2.2, width: 0.58, crest: 5.08, impact: -0.64, depth: -18.28 }),
    ]);
    const waterfallVolumeMaterials = Object.freeze([
      waterfallMid,
      waterfallMain,
      waterfallVeil,
      waterfallMain,
      waterfallMid,
    ]);
    const wetnessTrails = new Group();
    wetnessTrails.name = "hero-b:waterfall-wetness-gradients";
    const impactPlumes = new Group();
    impactPlumes.name = "hero-b:waterfall-impact-plumes";
    const outflowFoam = new Group();
    outflowFoam.name = "hero-b:waterfall-directional-outflow";
    for (let volumeIndex = 0; volumeIndex < waterfallVolumes.length; volumeIndex += 1) {
      const volume = waterfallVolumes[volumeIndex]!;
      const volumeSeed = seed ^ (0x41a7_6bd3 + volumeIndex * 0x1021);
      const wetnessTrail = new Mesh(
        this.#ownGeometry(waterfallWetTrailGeometry(
          volumeSeed ^ 0x63a9_17c5,
          volume.centerX,
          volume.width * 1.82,
          volume.crest + 0.1,
          volume.impact - 0.16,
          volume.depth - 0.24,
        )),
        wetTrailMaterial,
      );
      wetnessTrail.name = `hero-b:waterfall-wetness-trail:${volumeIndex}`;
      wetnessTrail.renderOrder = 1;
      wetnessTrails.add(wetnessTrail);

      const volumeMesh = new Mesh(
        this.#ownGeometry(waterfallVolumeGeometry(
          volumeSeed,
          volume.centerX,
          volume.width,
          volume.crest,
          volume.impact,
          volume.depth,
        )),
        waterfallVolumeMaterials[volumeIndex]!,
      );
      volumeMesh.name = `hero-b:waterfall-volume:${volumeIndex}`;
      volumeMesh.renderOrder = 2 + volumeIndex;
      this.#waterfallRoot.add(volumeMesh);

      const plume = new Mesh(
        this.#ownGeometry(waterfallImpactPlumeGeometry(volumeSeed ^ 0x5f26_a19b)),
        impactPlumeMaterial,
      );
      plume.name = `hero-b:waterfall-impact-plume:${volumeIndex}`;
      plume.position.set(volume.centerX, volume.impact - 0.2, volume.depth + 1.55);
      plume.scale.set(
        volume.width * 2.18,
        1.42 + volume.width * 0.72,
        volume.width * 1.92,
      );
      plume.renderOrder = 6;
      impactPlumes.add(plume);

      const outflow = new Mesh(
        this.#ownGeometry(waterfallOutflowRibbonGeometry(
          volumeSeed ^ 0x8c13_4fa7,
          2.65 + volume.width * 1.18,
          volume.width * 1.52,
        )),
        outflowMaterial,
      );
      outflow.name = `hero-b:waterfall-outflow-foam:${volumeIndex}`;
      outflow.position.set(volume.centerX, -1.01, volume.depth + 1.02);
      outflow.renderOrder = 7;
      outflowFoam.add(outflow);
    }
    this.#waterfallRoot.add(wetnessTrails, impactPlumes, outflowFoam);

    const lipWhitewater = new Group();
    lipWhitewater.name = "hero-b:waterfall-lip-whitewater";
    for (let volumeIndex = 0; volumeIndex < waterfallVolumes.length; volumeIndex += 1) {
      const volume = waterfallVolumes[volumeIndex]!;
      const whitewater = new Mesh(
        this.#ownGeometry(waterfallLipRibbonGeometry(
          seed ^ (0x2c86_75a1 + volumeIndex * 0x101),
          volume.width * 0.78,
        )),
        foamMaterial,
      );
      whitewater.name = `hero-b:waterfall-lip-whitewater:${volumeIndex}`;
      whitewater.position.set(volume.centerX, volume.crest + 0.035, volume.depth + 0.055);
      whitewater.renderOrder = 5;
      lipWhitewater.add(whitewater);
    }
    this.#waterfallRoot.add(lipWhitewater);

    const waterfallStreams = new Group();
    waterfallStreams.name = "hero-b:connected-waterfall";
    const waterfallStreamX = Object.freeze([
      -2.18, -0.68, 0.54, 1.84,
    ]);
    const waterfallRandom = randomFrom(seed ^ 0xd0a6_418c);
    for (let streamIndex = 0; streamIndex < waterfallStreamX.length; streamIndex += 1) {
      const x = waterfallStreamX[streamIndex]!;
      const phase = waterfallRandom.range(0, TAU);
      const depth = -18.22 + waterfallRandom.range(-0.62, 0.62);
      const crest = 5.5 + waterfallRandom.range(-0.12, 0.22);
      const impact = -1.42 + waterfallRandom.range(-0.16, 0.18);
      const curve = new CatmullRomCurve3([
        new Vector3(x, crest, depth),
        new Vector3(
          x + Math.sin(phase) * 0.16,
          4.18 + waterfallRandom.range(-0.18, 0.16),
          depth + waterfallRandom.range(-0.06, 0.14),
        ),
        new Vector3(
          x + Math.cos(phase * 1.3) * 0.27,
          2.5 + waterfallRandom.range(-0.24, 0.24),
          depth + waterfallRandom.range(0.02, 0.3),
        ),
        new Vector3(
          x + Math.sin(phase * 1.7) * 0.2,
          0.62 + waterfallRandom.range(-0.22, 0.2),
          depth + waterfallRandom.range(0.18, 0.46),
        ),
        new Vector3(
          x + Math.cos(phase * 0.9) * 0.17,
          impact,
          depth + waterfallRandom.range(0.38, 0.72),
        ),
      ]);
      const waterfallGeometry = this.#ownGeometry(taperedWaterfallStreamGeometry(
        curve,
        0.045 + waterfallRandom.range(0, 0.055),
        phase,
      ));
      const stream = new Mesh(
        waterfallGeometry,
        streamIndex % 3 === 0 ? waterfallMid : waterfallVeil,
      );
      stream.name = `hero-b:waterfall-stream:${streamIndex}`;
      stream.renderOrder = 3;
      waterfallStreams.add(stream);
    }
    this.#waterfallRoot.add(waterfallStreams);

    const cliffGeometry = this.#ownGeometry(organicRockGeometry(seed ^ 0x89a4_72c1));
    const cliffSpecs = Object.freeze([
      [-3.48, 0.08, -18.68, 1.48, 1.74, 1.18],
      [-3.64, 2.52, -18.76, 1.52, 1.66, 1.14],
      [-3.34, 4.82, -18.84, 1.42, 1.36, 1.08],
      [-2.72, 5.48, -18.72, 1.28, 0.78, 1.02],
      [3.54, 0.16, -18.7, 1.5, 1.82, 1.2],
      [3.68, 2.64, -18.78, 1.5, 1.7, 1.14],
      [3.38, 4.86, -18.86, 1.4, 1.38, 1.06],
      [2.7, 5.46, -18.74, 1.24, 0.76, 1],
      [-2.82, -1.1, -17.64, 1.18, 0.72, 1.05],
      [2.78, -1.12, -17.62, 1.2, 0.74, 1.08],
      [-1.46, 5.72, -18.92, 1.46, 0.5, 1.02],
      [1.38, 5.74, -18.94, 1.5, 0.48, 1.04],
    ] as const);
    for (let cliffIndex = 0; cliffIndex < cliffSpecs.length; cliffIndex += 1) {
      const [x, y, z, scaleX, scaleY, scaleZ] = cliffSpecs[cliffIndex]!;
      const cliff = new Mesh(cliffGeometry, cliffRock);
      cliff.name = `hero-b:waterfall-cliff-rock:${cliffIndex}`;
      cliff.position.set(x, y, z);
      cliff.rotation.set(
        (cliffIndex % 3 - 1) * 0.13,
        cliffIndex * 0.61,
        (cliffIndex % 4 - 1.5) * 0.08,
      );
      cliff.scale.set(scaleX, scaleY, scaleZ);
      this.#waterfallRoot.add(cliff);
    }

    const waterfallGapRocks = Object.freeze([
      [-2.06, 2.58, -17.98, 0.4, 0.54, 0.44],
      [-1.02, 3.46, -17.7, 0.46, 0.55, 0.5],
      [-0.18, 1.92, -17.94, 0.36, 0.58, 0.42],
      [0.86, 1.28, -17.7, 0.48, 0.5, 0.52],
      [1.94, 2.7, -17.98, 0.4, 0.52, 0.44],
      [0.04, -0.82, -16.86, 0.62, 0.34, 0.66],
    ] as const);
    for (let rockIndex = 0; rockIndex < waterfallGapRocks.length; rockIndex += 1) {
      const [x, y, z, scaleX, scaleY, scaleZ] = waterfallGapRocks[rockIndex]!;
      const wetRock = new Mesh(cliffGeometry, wetCliffRock);
      wetRock.name = `hero-b:waterfall-gap-rock:${rockIndex}`;
      wetRock.position.set(x, y, z);
      wetRock.rotation.set(
        (rockIndex % 3 - 1) * 0.18,
        rockIndex * 0.73,
        (rockIndex % 2 === 0 ? -1 : 1) * 0.11,
      );
      wetRock.scale.set(scaleX, scaleY, scaleZ);
      wetRock.renderOrder = 1;
      this.#waterfallRoot.add(wetRock);
    }

    const dummy = new Object3D();
    const treeShadowGeometry = this.#ownGeometry(new PlaneGeometry(2.4, 1.55, 1, 1));
    const trunkGeometry = this.#ownGeometry(organicTrunkGeometry(seed ^ 0x7c31_a2d5));
    const branchGeometry = this.#ownGeometry(organicBranchGeometry(seed ^ 0x42bd_731f));
    branchGeometry.name = "hero-b:organic-curved-branch-geometry";
    const crownGeometry = this.#ownGeometry(organicCrownGeometry(seed ^ 0x3a18_d6c9));
    const treeTrunks = this.#treeTrunks = new InstancedMesh(trunkGeometry, bark, 48);
    const treeCrowns = this.#treeCrowns = new InstancedMesh(crownGeometry, leaf, 48);
    const treeCrownLobeA = new InstancedMesh(crownGeometry, leaf, 48);
    const treeCrownLobeB = new InstancedMesh(crownGeometry, leaf, 48);
    const treeCrownLobeC = new InstancedMesh(crownGeometry, leaf, 48);
    const treeCrownLobeD = new InstancedMesh(crownGeometry, leaf, 48);
    const treeCrownLobes = this.#treeCrownLobes = Object.freeze([
      treeCrownLobeA,
      treeCrownLobeB,
      treeCrownLobeC,
      treeCrownLobeD,
    ]);
    const treeLeafCards = this.#treeLeafCards = new InstancedMesh(
      this.#ownGeometry(new PlaneGeometry(1, 1, 1, 1)),
      leafCardMaterial,
      240,
    );
    const treeBranches = this.#treeBranches = new InstancedMesh(branchGeometry, bark, 192);
    const treeShadows = this.#treeShadows = new InstancedMesh(
      treeShadowGeometry,
      contactShadowMaterial,
      48,
    );
    const forestMassGeometry = this.#ownGeometry(forestLayerMassGeometry(seed ^ 0x1c75_a92d));
    forestMassGeometry.name = "hero-b:layered-canopy-mass-geometry";
    const foregroundCanopy = this.#foregroundCanopy = new InstancedMesh(
      forestMassGeometry,
      canopyMassMaterial,
      8,
    );
    const midUnderstory = this.#midUnderstory = new InstancedMesh(
      forestMassGeometry,
      canopyMassMaterial,
      20,
    );
    const backgroundCanopy = this.#backgroundCanopy = new InstancedMesh(
      forestMassGeometry,
      canopyMassMaterial,
      16,
    );
    treeTrunks.name = "hero-b:stable-tree-trunks";
    treeCrowns.name = "hero-b:stable-tree-crowns";
    treeCrownLobeA.name = "hero-b:tree-crown-lobes-a";
    treeCrownLobeB.name = "hero-b:tree-crown-lobes-b";
    treeCrownLobeC.name = "hero-b:tree-crown-lobes-c";
    treeCrownLobeD.name = "hero-b:tree-crown-lobes-d";
    treeBranches.name = "hero-b:tree-branches";
    treeShadows.name = "hero-b:tree-contact-shadows";
    treeLeafCards.name = "hero-b:tree-leaf-card-layers";
    foregroundCanopy.name = "hero-b:asymmetric-foreground-canopy";
    midUnderstory.name = "hero-b:overlapping-mid-understory";
    backgroundCanopy.name = "hero-b:continuous-distant-canopy-belt";
    const crownColor = new Color();
    const leafCardColor = new Color();
    const trunkColor = new Color();
    const layerColor = new Color();
    for (let index = 0; index < 48; index += 1) {
      const layerSlot = index % 4;
      const forestLayer = layerSlot === 0 ? 0 : layerSlot === 3 ? 2 : 1;
      const side = index % 2 === 0 ? -1 : 1;
      const z = forestLayer === 0
        ? random.range(2, 10)
        : forestLayer === 1 ? random.range(-7, 3) : random.range(-17, -7);
      const center = riverCenter(z);
      const x = center + side * (forestLayer === 0
        ? random.range(7.2, 15.5)
        : forestLayer === 1 ? random.range(5.2, 13.2) : random.range(3.8, 11.2));
      const groundY = terrainHeight(x, z, seed) - 0.9;
      const height = forestLayer === 0
        ? random.range(4.5, 6.2)
        : forestLayer === 1 ? random.range(3.45, 5.25) : random.range(2.3, 4.05);
      const width = forestLayer === 0
        ? random.range(0.88, 1.28)
        : forestLayer === 1 ? random.range(0.66, 1.08) : random.range(0.48, 0.84);
      const distanceLayer = forestLayer / 2;
      if (Math.abs(x - center) < SAFE_CORRIDOR_HALF_WIDTH) this.#safeCorridorClear = false;
      dummy.position.set(x, groundY + 0.018, z);
      dummy.rotation.set(-Math.PI / 2, 0, random.range(0, TAU));
      dummy.scale.set(width * 1.75, width * 1.25, 1);
      dummy.updateMatrix();
      treeShadows.setMatrixAt(index, dummy.matrix);
      dummy.position.set(x, groundY + height * 0.5, z);
      dummy.rotation.set(0, random.range(0, TAU), 0);
      dummy.scale.set(random.range(0.75, 1.18), height, random.range(0.75, 1.18));
      dummy.updateMatrix();
      treeTrunks.setMatrixAt(index, dummy.matrix);
      trunkColor.setHSL(
        0.075 + distanceLayer * 0.015,
        0.38 - distanceLayer * 0.2,
        0.2 + distanceLayer * 0.16,
      );
      treeTrunks.setColorAt(index, trunkColor);
      const species = Math.min(3, Math.floor(
        hashedUnit(index, forestLayer, seed ^ 0x38d7_1b4f) * 4,
      ));
      const canopySpread = species === 0 ? 0.58 : species === 1 ? 1.24 : species === 2 ? 0.86 : 1.08;
      const canopyLift = species === 0 ? 1.28 : species === 1 ? 0.76 : species === 2 ? 1 : 1.12;
      const canopySkew = species === 3
        ? side * width * 0.5
        : (hashedUnit(index, species, seed ^ 0x91c7_4f2b) - 0.5) * width * 0.18;
      dummy.position.set(x + canopySkew, groundY + height + width * 0.8 * canopyLift, z);
      dummy.rotation.set(random.range(-0.06, 0.06), random.range(0, TAU), random.range(-0.06, 0.06));
      const speciesScale = species === 0
        ? [0.72, 1.52, 0.8]
        : species === 1
          ? [1.62, 0.64, 1.18]
          : species === 2
            ? [1.14, 1.02, 0.72]
            : [0.94, 1.2, 1.34];
      dummy.scale.set(
        width * speciesScale[0]!,
        width * speciesScale[1]!,
        width * speciesScale[2]!,
      );
      dummy.updateMatrix();
      treeCrowns.setMatrixAt(index, dummy.matrix);
      crownColor.setHSL(
        0.27 + species * 0.012 + distanceLayer * 0.035
          + hashedUnit(index, 2, seed ^ 0xb18d_44e3) * 0.018,
        0.5 - distanceLayer * 0.27
          + hashedUnit(index, 3, seed ^ 0x4a31_9c6f) * 0.08,
        0.3 + distanceLayer * 0.25
          + hashedUnit(index, 4, seed ^ 0x7e63_20d5) * 0.055,
      );
      treeCrowns.setColorAt(index, crownColor);

      const lobeAngle = hashedUnit(index, 0, seed ^ 0xa31c_7d92) * TAU;
      const lobeLift = hashedUnit(index, 1, seed ^ 0x6f82_451b) * 0.26;
      const cardSpread = species === 0 ? 0.58 : species === 1 ? 1.28 : species === 2 ? 0.9 : 1.08;
      const cardHeight = species === 0 ? 1.2 : species === 1 ? 0.72 : species === 2 ? 0.96 : 0.88;
      for (let cardIndex = 0; cardIndex < 5; cardIndex += 1) {
        const cardAngle = (cardIndex - 2) * Math.PI / 5;
        dummy.position.set(
          x + canopySkew + Math.cos(lobeAngle + cardAngle) * width
            * (0.08 + (cardIndex % 2) * 0.1) * canopySpread,
          groundY + height + width * (0.78 + (cardIndex % 3) * 0.13) * canopyLift,
          z + Math.sin(lobeAngle + cardAngle) * width
            * (0.16 + (cardIndex % 2) * 0.13) * canopySpread,
        );
        dummy.rotation.set((cardIndex % 2 - 0.5) * 0.06, cardAngle, (cardIndex - 2) * 0.028);
        dummy.scale.set(
          width * (2.1 + (cardIndex % 3) * 0.22) * cardSpread,
          width * (1.86 + (cardIndex % 2) * 0.18) * cardHeight,
          1,
        );
        dummy.updateMatrix();
        treeLeafCards.setMatrixAt(index * 5 + cardIndex, dummy.matrix);
        leafCardColor.copy(crownColor).offsetHSL(
          (cardIndex - 2) * 0.003,
          (cardIndex % 2) * 0.015,
          (cardIndex % 3 - 1) * 0.025,
        );
        treeLeafCards.setColorAt(index * 5 + cardIndex, leafCardColor);
      }
      dummy.position.set(
        x + canopySkew + Math.cos(lobeAngle) * width * 0.72 * canopySpread,
        groundY + height + width * (0.58 + lobeLift) * canopyLift,
        z + Math.sin(lobeAngle) * width * 0.6 * canopySpread,
      );
      dummy.rotation.set(0.08, lobeAngle, -0.06);
      dummy.scale.set(
        width * 0.82 * canopySpread,
        width * 0.68 * canopyLift,
        width * 0.76 * canopySpread,
      );
      dummy.updateMatrix();
      treeCrownLobeA.setMatrixAt(index, dummy.matrix);
      crownColor.offsetHSL(0.006, 0.015, 0.025);
      treeCrownLobeA.setColorAt(index, crownColor);

      dummy.position.set(
        x + canopySkew - Math.cos(lobeAngle) * width * 0.58 * canopySpread,
        groundY + height + width * (1.02 + lobeLift * 0.4) * canopyLift,
        z - Math.sin(lobeAngle) * width * 0.5 * canopySpread,
      );
      dummy.rotation.set(-0.05, lobeAngle + Math.PI * 0.5, 0.08);
      dummy.scale.set(
        width * 0.7 * canopySpread,
        width * 0.62 * canopyLift,
        width * 0.68 * canopySpread,
      );
      dummy.updateMatrix();
      treeCrownLobeB.setMatrixAt(index, dummy.matrix);
      crownColor.offsetHSL(-0.012, -0.01, -0.035);
      treeCrownLobeB.setColorAt(index, crownColor);

      dummy.position.set(
        x + canopySkew + Math.cos(lobeAngle + 2.25) * width * 0.54 * canopySpread,
        groundY + height + width * (0.86 - lobeLift * 0.16) * canopyLift,
        z + Math.sin(lobeAngle + 2.25) * width * 0.56 * canopySpread,
      );
      dummy.rotation.set(0.04, lobeAngle - 0.62, 0.07);
      dummy.scale.set(
        width * 0.66 * canopySpread,
        width * 0.58 * canopyLift,
        width * 0.72 * canopySpread,
      );
      dummy.updateMatrix();
      treeCrownLobeC.setMatrixAt(index, dummy.matrix);
      crownColor.offsetHSL(0.018, 0.02, 0.045);
      treeCrownLobeC.setColorAt(index, crownColor);

      dummy.position.set(
        x + canopySkew + Math.cos(lobeAngle - 2.1) * width * 0.48 * canopySpread,
        groundY + height + width * (0.94 + lobeLift * 0.22) * canopyLift,
        z + Math.sin(lobeAngle - 2.1) * width * 0.5 * canopySpread,
      );
      dummy.rotation.set(-0.06, lobeAngle + 0.78, -0.05);
      dummy.scale.set(
        width * 0.61 * canopySpread,
        width * 0.7 * canopyLift,
        width * 0.64 * canopySpread,
      );
      dummy.updateMatrix();
      treeCrownLobeD.setMatrixAt(index, dummy.matrix);
      crownColor.offsetHSL(-0.022, -0.015, -0.025);
      treeCrownLobeD.setColorAt(index, crownColor);

      for (let branchIndex = 0; branchIndex < 4; branchIndex += 1) {
        const visibleBranchCount = forestLayer === 0 ? 3 : forestLayer === 1 ? 2 : 0;
        if (branchIndex >= visibleBranchCount) {
          dummy.position.set(x, groundY + height * 0.7, z);
          dummy.scale.set(0, 0, 0);
          dummy.updateMatrix();
          treeBranches.setMatrixAt(index * 4 + branchIndex, dummy.matrix);
          treeBranches.setColorAt(index * 4 + branchIndex, trunkColor);
          continue;
        }
        const direction = hashedUnit(index, branchIndex, seed ^ 0xa47d_215b) < 0.5 ? -1 : 1;
        const branchAngle = lobeAngle + hashedUnit(
          index,
          branchIndex,
          seed ^ 0x1ed4_90b7,
        ) * TAU;
        const branchLength = height * (0.18 + hashedUnit(
          index,
          branchIndex,
          seed ^ 0xd371_6ea9,
        ) * (forestLayer === 0 ? 0.16 : 0.1));
        dummy.position.set(
          x + Math.cos(branchAngle) * branchLength * 0.28,
          groundY + height * (0.52 + hashedUnit(
            branchIndex,
            index,
            seed ^ 0x6c82_31e7,
          ) * 0.36),
          z + Math.sin(branchAngle) * branchLength * 0.24,
        );
        dummy.rotation.set(
          Math.sin(branchAngle) * 0.14,
          branchAngle,
          direction * (0.54 + hashedUnit(index, branchIndex, seed ^ 0x7db2_54c1) * 0.48),
        );
        dummy.scale.set(width * 0.36, branchLength, width * 0.36);
        dummy.updateMatrix();
        treeBranches.setMatrixAt(index * 4 + branchIndex, dummy.matrix);
        treeBranches.setColorAt(index * 4 + branchIndex, trunkColor);
      }
    }
    for (let index = 0; index < 8; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const z = 3 + Math.floor(index / 2) * 1.3 + random.range(-0.45, 0.45);
      const center = riverCenter(z);
      const x = center + side * random.range(9.2, 15.4);
      const groundY = terrainHeight(x, z, seed) - 0.9;
      dummy.position.set(
        x + side * random.range(-0.6, 0.9),
        groundY + random.range(5.1, 6.8),
        z,
      );
      dummy.rotation.set(random.range(-0.12, 0.12), random.range(0, TAU), random.range(-0.16, 0.16));
      dummy.scale.set(
        random.range(2.15, 3.35),
        random.range(1.15, 2.05),
        random.range(1.55, 2.55),
      );
      dummy.updateMatrix();
      foregroundCanopy.setMatrixAt(index, dummy.matrix);
      layerColor.setHSL(
        0.27 + random.range(-0.015, 0.018),
        random.range(0.42, 0.58),
        random.range(0.28, 0.38),
      );
      foregroundCanopy.setColorAt(index, layerColor);
    }
    for (let index = 0; index < 20; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const row = Math.floor(index / 2);
      const z = -7 + row * 0.68 + random.range(-0.42, 0.42);
      const center = riverCenter(z);
      const x = center + side * random.range(3.7, 10.8);
      const groundY = terrainHeight(x, z, seed) - 0.9;
      dummy.position.set(x, groundY + random.range(0.55, 1.45), z);
      dummy.rotation.set(random.range(-0.08, 0.08), random.range(0, TAU), random.range(-0.1, 0.1));
      dummy.scale.set(
        random.range(1.35, 2.45),
        random.range(0.62, 1.15),
        random.range(1.15, 2.15),
      );
      dummy.updateMatrix();
      midUnderstory.setMatrixAt(index, dummy.matrix);
      layerColor.setHSL(
        0.29 + random.range(-0.012, 0.018),
        random.range(0.22, 0.32),
        random.range(0.52, 0.62),
      );
      midUnderstory.setColorAt(index, layerColor);
    }
    for (let index = 0; index < 16; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const column = Math.floor(index / 2);
      const z = -20.2 - column % 3 * 1.35 + random.range(-0.35, 0.35);
      const center = riverCenter(z);
      const x = center + side * (4.15 + column * 1.02 + random.range(-0.25, 0.42));
      const groundY = terrainHeight(x, z, seed) - 0.9;
      dummy.position.set(x, groundY + random.range(2.1, 3.15), z);
      dummy.rotation.set(random.range(-0.04, 0.04), random.range(0, TAU), random.range(-0.07, 0.07));
      dummy.scale.set(
        random.range(2.75, 3.9),
        random.range(1.45, 2.35),
        random.range(1.9, 2.9),
      );
      dummy.updateMatrix();
      backgroundCanopy.setMatrixAt(index, dummy.matrix);
      layerColor.setHSL(
        0.33 + random.range(-0.012, 0.014),
        random.range(0.05, 0.11),
        random.range(0.82, 0.91),
      );
      backgroundCanopy.setColorAt(index, layerColor);
    }
    treeTrunks.instanceMatrix.needsUpdate = true;
    treeCrowns.instanceMatrix.needsUpdate = true;
    treeCrownLobeA.instanceMatrix.needsUpdate = true;
    treeCrownLobeB.instanceMatrix.needsUpdate = true;
    treeCrownLobeC.instanceMatrix.needsUpdate = true;
    treeCrownLobeD.instanceMatrix.needsUpdate = true;
    if (treeCrowns.instanceColor) treeCrowns.instanceColor.needsUpdate = true;
    if (treeCrownLobeA.instanceColor) treeCrownLobeA.instanceColor.needsUpdate = true;
    if (treeCrownLobeB.instanceColor) treeCrownLobeB.instanceColor.needsUpdate = true;
    if (treeCrownLobeC.instanceColor) treeCrownLobeC.instanceColor.needsUpdate = true;
    if (treeCrownLobeD.instanceColor) treeCrownLobeD.instanceColor.needsUpdate = true;
    if (treeTrunks.instanceColor) treeTrunks.instanceColor.needsUpdate = true;
    if (treeBranches.instanceColor) treeBranches.instanceColor.needsUpdate = true;
    if (treeLeafCards.instanceColor) treeLeafCards.instanceColor.needsUpdate = true;
    foregroundCanopy.instanceMatrix.needsUpdate = true;
    midUnderstory.instanceMatrix.needsUpdate = true;
    backgroundCanopy.instanceMatrix.needsUpdate = true;
    if (foregroundCanopy.instanceColor) foregroundCanopy.instanceColor.needsUpdate = true;
    if (midUnderstory.instanceColor) midUnderstory.instanceColor.needsUpdate = true;
    if (backgroundCanopy.instanceColor) backgroundCanopy.instanceColor.needsUpdate = true;
    treeBranches.instanceMatrix.needsUpdate = true;
    treeShadows.instanceMatrix.needsUpdate = true;
    treeLeafCards.instanceMatrix.needsUpdate = true;
    this.#forestRoot.add(
      backgroundCanopy,
      midUnderstory,
      treeShadows,
      treeTrunks,
      treeBranches,
      treeCrowns,
      ...treeCrownLobes,
      treeLeafCards,
      foregroundCanopy,
    );

    const grassGeometry = this.#ownGeometry(grassTuftGeometry());
    const grass = this.#grass = new InstancedMesh(grassGeometry, grassMaterial, 144);
    grass.name = "hero-b:stable-grass-clusters";
    for (let index = 0; index < 144; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const z = random.range(-15, 11);
      const x = riverCenter(z) + side * random.range(3.15, 13.5);
      dummy.position.set(x, terrainHeight(x, z, seed) - 0.5, z);
      dummy.rotation.set(0, random.range(0, TAU), random.range(-0.12, 0.12));
      const scale = random.range(0.82, 1.72);
      dummy.scale.set(scale * random.range(0.78, 1.16), scale, scale);
      dummy.updateMatrix();
      grass.setMatrixAt(index, dummy.matrix);
    }
    grass.instanceMatrix.needsUpdate = true;
    this.#forestRoot.add(grass);

    const flowerGeometry = this.#ownGeometry(new IcosahedronGeometry(0.075, 2));
    const flowers = this.#flowers = new InstancedMesh(flowerGeometry, flowerMaterial, 72);
    flowers.name = "hero-b:forest-flowers";
    for (let index = 0; index < 72; index += 1) {
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

    const fireflyGeometry = this.#ownGeometry(new IcosahedronGeometry(0.04, 1));
    const fireflies = this.#fireflies = new InstancedMesh(fireflyGeometry, fireflyMaterial, 84);
    fireflies.name = "hero-b:preallocated-life-fireflies";
    for (let index = 0; index < 84; index += 1) {
      const z = random.range(-15.5, 8.5);
      const center = riverCenter(z);
      const side = index % 2 === 0 ? -1 : 1;
      const x = center + side * random.range(2.7, 11.5);
      dummy.position.set(
        x,
        terrainHeight(x, z, seed) + random.range(0.15, 2.2),
        z,
      );
      const glowScale = random.range(0.42, 1.5);
      dummy.scale.setScalar(glowScale);
      dummy.rotation.set(0, random.range(0, TAU), 0);
      dummy.updateMatrix();
      fireflies.setMatrixAt(index, dummy.matrix);
    }
    fireflies.instanceMatrix.needsUpdate = true;
    this.#forestRoot.add(fireflies);

    const birdGeometry = this.#ownGeometry(flyingBirdGeometry());
    const birds = this.#birds = new InstancedMesh(birdGeometry, birdMaterial, 22);
    birds.name = "hero-b:bird-flow";
    for (let index = 0; index < 22; index += 1) {
      dummy.position.set(
        -7 + (index % 11) * 1.35,
        6.4 + (index % 4) * 0.34,
        -12 + Math.floor(index / 11) * 2.6 + Math.sin(index) * 0.6,
      );
      dummy.rotation.set(0, 0, Math.PI / 2 + (index % 3 - 1) * 0.12);
      const scale = 0.28 + (index % 4) * 0.055;
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      birds.setMatrixAt(index, dummy.matrix);
    }
    birds.instanceMatrix.needsUpdate = true;
    this.#flowRoot.add(birds);

    const mistGeometry = this.#ownGeometry(waterfallMistWispGeometry());
    const mist = this.#mist = new InstancedMesh(mistGeometry, mistMaterial, 20);
    mist.name = "hero-b:waterfall-mist";
    for (let index = 0; index < 20; index += 1) {
      const angle = (index / 20) * TAU;
      dummy.position.set(
        Math.cos(angle) * (0.82 + (index % 4) * 0.58),
        -0.94 + (index % 5) * 0.42,
        -16.42 + Math.sin(angle) * 1.78,
      );
      dummy.rotation.set(0, angle, 0);
      const scale = 0.5 + (index % 3) * 0.18;
      dummy.scale.set(scale * 1.52, scale * 2.18, scale * 1.28);
      dummy.updateMatrix();
      mist.setMatrixAt(index, dummy.matrix);
    }
    mist.instanceMatrix.needsUpdate = true;
    mist.renderOrder = 6;
    this.#waterfallRoot.add(mist);

    const foamGeometry = this.#ownGeometry(waterfallFoamRibbonGeometry(seed ^ 0xb56a_94d1));
    const foam = this.#foam = new InstancedMesh(foamGeometry, foamMaterial, 32);
    foam.name = "hero-b:waterfall-impact-foam";
    const foamRandom = randomFrom(seed ^ 0x274e_c931);
    for (let index = 0; index < 32; index += 1) {
      const angle = foamRandom.range(0, TAU);
      const impactCenters = [-2.18, -0.98, 0.12, 1.02, 2.2] as const;
      const impactCenterX = impactCenters[index % impactCenters.length]!;
      const radius = foamRandom.range(0.24, 0.94);
      dummy.position.set(
        impactCenterX + Math.cos(angle) * radius,
        -1.035 + foamRandom.range(0, 0.055),
        -16.52 + Math.sin(angle) * radius * 0.72 + foamRandom.range(-0.14, 0.2),
      );
      dummy.rotation.set(
        0,
        angle + foamRandom.range(-0.45, 0.45),
        foamRandom.range(-0.04, 0.04),
      );
      const scale = foamRandom.range(0.38, 0.86);
      dummy.scale.set(scale * foamRandom.range(1.2, 1.95), 1, scale);
      dummy.updateMatrix();
      foam.setMatrixAt(index, dummy.matrix);
    }
    foam.instanceMatrix.needsUpdate = true;
    foam.renderOrder = 7;
    this.#waterfallRoot.add(foam);

    const cloudGeometry = this.#ownGeometry(cloudBillboardGeometry(seed ^ 0x7a13_5ed9));
    cloudGeometry.name = "hero-b:depth-layered-cloud-billboard-geometry";
    const clouds = this.#clouds = new InstancedMesh(cloudGeometry, cloudMaterial, 12);
    const cloudLobeA = new InstancedMesh(cloudGeometry, cloudMaterial, 12);
    const cloudLobeB = new InstancedMesh(cloudGeometry, cloudMaterial, 12);
    const cloudLobes = this.#cloudLobes = Object.freeze([cloudLobeA, cloudLobeB]);
    clouds.name = "hero-b:stable-cloud-clusters";
    cloudLobeA.name = "hero-b:cloud-lobes-a";
    cloudLobeB.name = "hero-b:cloud-lobes-b";
    for (let index = 0; index < 12; index += 1) {
      const depthBand = index % 3;
      const column = Math.floor(index / 3);
      const x = -15.5 + column * 10.1 + random.range(-1.15, 1.15);
      const y = 9.55 + depthBand * 1.08 + random.range(-0.32, 0.4);
      const z = -23.5 - depthBand * 6.4 + random.range(-0.7, 0.7);
      const rotationZ = random.range(-0.14, 0.14);
      const scaleX = random.range(1.2, 2.35) * (1 - depthBand * 0.09);
      const scaleY = random.range(0.72, 1.18) * (1 - depthBand * 0.08);
      const scaleZ = random.range(0.88, 1.12);
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, 0, rotationZ);
      dummy.scale.set(scaleX, scaleY, scaleZ);
      dummy.updateMatrix();
      clouds.setMatrixAt(index, dummy.matrix);

      const drift = hashedUnit(index, 0, seed ^ 0x537a_1dc9) * 0.48;
      dummy.position.set(
        x - scaleX * (0.48 + drift * 0.16),
        y + scaleY * (0.16 + drift * 0.1),
        z + scaleZ * 0.08,
      );
      dummy.rotation.set(0, 0, rotationZ - 0.08);
      dummy.scale.set(scaleX * 0.62, scaleY * 0.76, scaleZ * 0.76);
      dummy.updateMatrix();
      cloudLobeA.setMatrixAt(index, dummy.matrix);

      dummy.position.set(
        x + scaleX * (0.5 - drift * 0.12),
        y - scaleY * (0.08 + drift * 0.07),
        z - scaleZ * 0.12,
      );
      dummy.rotation.set(0, 0, rotationZ + 0.095);
      dummy.scale.set(scaleX * 0.56, scaleY * 0.68, scaleZ * 0.7);
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
    this.#protagonistRoot.scale.setScalar(0.62);
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
    if (this.#initializePromise) return this.#initializePromise;
    const attempt = this.#loadSurfaceTextures().then(() => {
      if (this.#state === "disposed" || this.#state === "disposing") {
        throw new Error("Forest/city Hero feature was disposed during initialization.");
      }
      this.#state = "ready";
    });
    this.#initializePromise = attempt;
    return attempt;
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
      0.025 + cityMix * 0.065,
      0.075 + cityMix * 0.035,
      0.075 + cityMix * 0.02,
    );
    this.#aerialFog.color.setRGB(
      0.115 + cityMix * 0.08,
      0.16 + cityMix * 0.035,
      0.14 + cityMix * 0.015,
    );
    this.#aerialFog.density = 0.012 + cityMix * 0.0015;
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
          const image: unknown = owned.texture.image;
          if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
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
      visibleFireflies: forestVisible ? this.#fireflies.count : 0,
      visibleSunbeams: forestVisible
        ? this.#sunbeams.reduce((count, beam) => count + (beam.visible ? 1 : 0), 0)
        : 0,
      visibleBirds: this.#flowRoot.visible ? this.#birds.count : 0,
      visibleMistClusters: this.#waterfallRoot.visible ? this.#mist.count : 0,
      visibleFoamClusters: this.#waterfallRoot.visible ? this.#foam.count : 0,
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

  #surfaceTexturePair(
    name: string,
    url: string,
    repeatX: number,
    repeatY: number,
  ): Readonly<HeroSurfaceTexturePair> {
    const albedo = this.#ownTexture(new Texture());
    albedo.name = `${name}:albedo`;
    albedo.wrapS = RepeatWrapping;
    albedo.wrapT = RepeatWrapping;
    albedo.repeat.set(repeatX, repeatY);
    albedo.colorSpace = SRGBColorSpace;
    const bump = this.#ownTexture(new Texture());
    bump.name = `${name}:bump`;
    bump.wrapS = RepeatWrapping;
    bump.wrapT = RepeatWrapping;
    bump.repeat.set(repeatX, repeatY);
    bump.colorSpace = NoColorSpace;
    this.#surfaceTextureLoads.push({ albedo, bump, url });
    return Object.freeze({ map: albedo, bumpMap: bump });
  }

  async #loadSurfaceTextures(): Promise<void> {
    if (typeof window === "undefined" || typeof createImageBitmap !== "function") return;
    const loaded: Array<Readonly<{
      albedo: Texture;
      bump: Texture;
      albedoImage: ImageBitmap;
      bumpImage: ImageBitmap;
    }>> = [];
    try {
      for (const entry of this.#surfaceTextureLoads) {
        const response = await fetch(entry.url, { cache: "force-cache" });
        if (!response.ok) {
          throw new Error(`Could not load Hero B surface texture ${entry.url}.`);
        }
        const blob = await response.blob();
        const [albedoImage, bumpImage] = await Promise.all([
          createImageBitmap(blob),
          createImageBitmap(blob),
        ]);
        loaded.push(Object.freeze({
          albedo: entry.albedo,
          bump: entry.bump,
          albedoImage,
          bumpImage,
        }));
      }
      if (this.#state === "disposed" || this.#state === "disposing") {
        throw new Error("Forest/city Hero feature was disposed while loading surface textures.");
      }
      for (const entry of loaded) {
        entry.albedo.image = entry.albedoImage;
        entry.albedo.needsUpdate = true;
        entry.bump.image = entry.bumpImage;
        entry.bump.needsUpdate = true;
      }
    } catch (error: unknown) {
      for (const entry of loaded) {
        entry.albedoImage.close();
        entry.bumpImage.close();
      }
      throw error;
    }
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
    const grassCount = high ? 144 : balanced ? 92 : 44;
    const flowerCount = high ? 72 : balanced ? 44 : 22;
    const fireflyCount = high ? 84 : balanced ? 52 : 24;
    const sunbeamCount = high ? 4 : balanced ? 3 : 2;
    const birdCount = high ? 22 : balanced ? 16 : 10;
    const mistCount = high ? 20 : balanced ? 14 : 8;
    const foamCount = high ? 32 : balanced ? 22 : 12;
    const cloudCount = high ? 12 : balanced ? 9 : 6;
    this.#treeTrunks.count = treeCount;
    this.#treeCrowns.count = treeCount;
    this.#treeBranches.count = treeCount * 4;
    this.#treeShadows.count = treeCount;
    this.#treeLeafCards.count = treeCount * 5;
    for (const lobe of this.#treeCrownLobes) lobe.count = treeCount;
    this.#foregroundCanopy.count = high ? 8 : balanced ? 6 : 4;
    this.#midUnderstory.count = high ? 20 : balanced ? 15 : 10;
    this.#backgroundCanopy.count = high ? 16 : balanced ? 12 : 8;
    this.#grass.count = grassCount;
    this.#flowers.count = flowerCount;
    this.#fireflies.count = fireflyCount;
    for (let index = 0; index < this.#sunbeams.length; index += 1) {
      this.#sunbeams[index]!.visible = index < sunbeamCount;
    }
    this.#birds.count = birdCount;
    this.#mist.count = mistCount;
    this.#foam.count = foamCount;
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
      this.#camera.position.set(0.15 + inputX * 0.34, 3.35 + inputY * 0.25, 13.4);
      this.#camera.lookAt(0, 0.8, -8.7);
      return;
    }
    this.#camera.position.set(
      0.4 + cityMix * 1.2 + inputX * 0.32,
      3.65 + cityMix * 0.28 + inputY * 0.22,
      13.8 - cityMix * 0.25,
    );
    this.#camera.lookAt(0.15, 1.15, -10.8);
  }

  #ownedObjectCount(): number {
    let count = 0;
    this.#root.traverse((object) => {
      if (object !== this.#root) count += 1;
    });
    return this.#state === "disposed" ? 0 : count + 3;
  }
}
