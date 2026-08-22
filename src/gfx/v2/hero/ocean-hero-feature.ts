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

interface HeroSurfaceTextureLoad {
  readonly albedo: Texture;
  readonly bump: Texture;
  readonly url: string;
}

interface HeroSurfaceTexturePair {
  readonly map: Texture;
  readonly bumpMap: Texture;
}

interface CoralPolypAnchor {
  readonly position: Vector3;
  readonly direction: Vector3;
}

interface BranchingCoralShape {
  readonly geometry: BufferGeometry;
  readonly polypAnchors: readonly CoralPolypAnchor[];
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

function proceduralHeightTexture(
  seed: number,
  repeatX: number,
  repeatY: number,
): DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coarse = periodicValueNoise(x, y, size, 7, seed);
      const fine = periodicValueNoise(x, y, size, 23, seed ^ 0x51ed_270b);
      const grain = hashedUnit(x, y, seed ^ 0x9e37_79b9);
      const height = Math.max(0, Math.min(1, coarse * 0.54 + fine * 0.34 + grain * 0.12));
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

function proceduralCausticMaskTexture(seed: number): DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size * 2 - 1;
      const ny = (y + 0.5) / size * 2 - 1;
      const radius = Math.sqrt(nx * nx + ny * ny);
      const edgeFade = Math.max(0, Math.min(1, (0.98 - radius) / 0.28));
      const warp = periodicValueNoise(x, y, size, 9, seed) * 1.6 - 0.8;
      const bands = Math.sin(nx * 10.5 + Math.sin(ny * 5.4 + warp) * 2.1)
        * Math.cos(ny * 8.2 + Math.sin(nx * 4.7 - warp) * 1.7);
      const filaments = Math.max(0, Math.abs(bands) - 0.58) / 0.42;
      const value = Math.round(Math.min(1, filaments * filaments * edgeFade) * 255);
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

function proceduralHazeMaskTexture(seed: number): DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size * 2 - 1;
      const ny = (y + 0.5) / size * 2 - 1;
      const radius = Math.sqrt(nx * nx + ny * ny);
      const edgeFade = Math.max(0, Math.min(1, (1 - radius) / 0.44));
      const coarse = periodicValueNoise(x, y, size, 5, seed);
      const fine = periodicValueNoise(x, y, size, 13, seed ^ 0x51e7_3ab9);
      const density = Math.max(0, Math.min(1, (coarse * 0.7 + fine * 0.3 - 0.18) * edgeFade));
      const value = Math.round(density * 255);
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
  const geometry = new IcosahedronGeometry(1, 4);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const angle = Math.atan2(z, x);
    const broad = Math.sin(angle * 3 + seed * 0.000_011) * 0.09
      + Math.cos(angle * 5 - y * 2.7 + seed * 0.000_019) * 0.055
      + Math.sin((x + z) * 3.2 + seed * 0.000_007) * 0.035;
    const variation = 0.91 + broad;
    const strata = 0.95 + Math.sin(y * 8.2 + angle * 0.8 + seed * 0.000_001) * 0.045;
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

function reefShelfGeometry(seed: number, side: -1 | 1): BufferGeometry {
  const columns = 12;
  const rows = 30;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    const rowT = row / rows;
    const z = 4.5 - rowT * 15;
    const innerEdge = 3.65
      + Math.sin(z * 0.43 + seed * 0.000_013) * 0.48
      + Math.sin(z * 0.17 - seed * 0.000_021) * 0.26;
    for (let column = 0; column <= columns; column += 1) {
      const across = column / columns;
      const eased = across * across * (3 - 2 * across);
      const radial = innerEdge + across * (7.2 - innerEdge);
      const x = side * radial;
      const ledge = Math.sin(z * 0.46 + across * 2.4 + seed * 0.000_009) * 0.17
        + Math.cos(x * 0.31 - z * 0.18) * 0.12;
      const y = -3.28 + eased * 2.05 + ledge * (0.45 + eased * 0.55);
      const mineral = 0.42 + eased * 0.22 + Math.sin(z * 0.37 + across * 4.1) * 0.08;
      positions.push(x, y, z);
      uvs.push(across * 2.4, rowT * 4.2);
      colors.push(
        0.22 + mineral * 0.18,
        0.35 + mineral * 0.2,
        0.31 + mineral * 0.14,
      );
    }
  }
  const stride = columns + 1;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = row * stride + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function underwaterDomeGeometry(): SphereGeometry {
  const radius = 46;
  const geometry = new SphereGeometry(radius, 36, 24);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const abyss = new Color(0x01111d);
  const middle = new Color(0x063c50);
  const surface = new Color(0x2f93a5);
  const current = new Color();
  for (let index = 0; index < positions.count; index += 1) {
    const height = Math.max(0, Math.min(1, (positions.getY(index) / radius + 1) * 0.5));
    if (height < 0.54) current.copy(abyss).lerp(middle, height / 0.54);
    else current.copy(middle).lerp(surface, (height - 0.54) / 0.46);
    colors[index * 3] = current.r;
    colors[index * 3 + 1] = current.g;
    colors[index * 3 + 2] = current.b;
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

function appendTaperedSegment(
  positions: number[],
  uvs: number[],
  indices: number[],
  start: Vector3,
  end: Vector3,
  startRadius: number,
  endRadius: number,
  radialSegments = 7,
): void {
  const tangent = new Vector3().subVectors(end, start).normalize();
  const reference = Math.abs(tangent.y) > 0.82
    ? new Vector3(1, 0, 0)
    : new Vector3(0, 1, 0);
  const axisA = new Vector3().crossVectors(tangent, reference).normalize();
  const axisB = new Vector3().crossVectors(tangent, axisA).normalize();
  const offset = positions.length / 3;
  for (let ring = 0; ring < 2; ring += 1) {
    const center = ring === 0 ? start : end;
    const radius = ring === 0 ? startRadius : endRadius;
    for (let radial = 0; radial <= radialSegments; radial += 1) {
      const angle = radial / radialSegments * TAU;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      positions.push(
        center.x + axisA.x * cosine * radius + axisB.x * sine * radius,
        center.y + axisA.y * cosine * radius + axisB.y * sine * radius,
        center.z + axisA.z * cosine * radius + axisB.z * sine * radius,
      );
      uvs.push(radial / radialSegments, ring);
    }
  }
  const stride = radialSegments + 1;
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const first = offset + radial;
    const second = first + stride;
    indices.push(first, second, first + 1, first + 1, second, second + 1);
  }
}

function seaFanSurfacePoint(seed: number, acrossInput: number, progressInput: number): Vector3 {
  const across = Math.max(-1, Math.min(1, acrossInput));
  const progress = Math.max(0, Math.min(1, progressInput));
  const phaseA = hashedUnit(0, 0, seed ^ 0x31b7_6e25) * TAU;
  const phaseB = hashedUnit(1, 0, seed ^ 0x8c42_19d7) * TAU;
  const leftTear = -0.66 + hashedUnit(2, 0, seed ^ 0x5a83_d149) * 0.34;
  const rightTear = 0.28 + hashedUnit(3, 0, seed ^ 0xb6e1_47a3) * 0.38;
  const tearDepth = 0.038 * Math.exp(-Math.pow((across - leftTear) / 0.065, 2))
    + 0.032 * Math.exp(-Math.pow((across - rightTear) / 0.072, 2));
  const edgeWidth = 0.87
    + Math.cos(across * Math.PI * 0.82 + phaseA) * 0.026
    + Math.sin(across * Math.PI * 1.45 + phaseB) * 0.014;
  const edgeHeight = 1.15
    + (1 - across * across) * 0.23
    + Math.sin(across * Math.PI * 1.05 + phaseA) * 0.034
    + Math.sin(across * Math.PI * 2.15 + phaseB) * 0.014
    - tearDepth;
  const bowDirection = hashedUnit(4, 0, seed ^ 0xd715_3a8c) < 0.5 ? -1 : 1;
  const bow = bowDirection * (
    0.075 + hashedUnit(5, 0, seed ^ 0x296c_b841) * 0.085
  );
  const twist = (hashedUnit(6, 0, seed ^ 0xe913_5b27) - 0.5) * 0.18;
  const radial = Math.pow(progress, 0.86);
  return new Vector3(
    across * edgeWidth * radial,
    edgeHeight * progress,
    (
      bow * (1 - across * across)
      + twist * across
      + Math.sin(across * Math.PI * 1.7 + phaseB) * 0.018
    ) * Math.sin(progress * Math.PI * 0.5),
  );
}

function seaFanGeometry(seed: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const branches = 7;
  const levels = 4;
  const branchNodes: Vector3[][] = [];
  for (let branch = 0; branch < branches; branch += 1) {
    const across = branch / (branches - 1) * 2 - 1;
    const base = seaFanSurfacePoint(seed, across, 0);
    let previous = base;
    const nodes: Vector3[] = [];
    for (let level = 1; level <= levels; level += 1) {
      const progress = 0.18 + level / levels * 0.68;
      const pathAcross = Math.max(-0.94, Math.min(0.94,
        across + Math.sin(level * 1.19 + branch * 0.83 + seed * 0.000_013) * progress * 0.028,
      ));
      const point = seaFanSurfacePoint(seed, pathAcross, progress);
      const startRadius = 0.026 - progress * 0.013;
      appendTaperedSegment(
        positions,
        uvs,
        indices,
        previous,
        point,
        startRadius,
        Math.max(0.0045, startRadius - 0.005),
        6,
      );
      nodes.push(point);
      previous = point;
    }
    branchNodes.push(nodes);
    for (let forkIndex = 0; forkIndex < 2; forkIndex += 1) {
      const start = nodes[1 + forkIndex]!;
      const outward = across === 0
        ? (forkIndex === 0 ? -1 : 1)
        : Math.sign(across) * (forkIndex === 0 ? -1 : 1);
      const forkProgress = 0.67 + forkIndex * 0.14
        + hashedUnit(forkIndex, branch, seed ^ 0xa173_4d95) * 0.035;
      const forkAcross = Math.max(-0.95, Math.min(0.95,
        across + outward * (
          0.12 + hashedUnit(branch, forkIndex, seed ^ 0x5c27_8ea1) * 0.075
        ),
      ));
      const fork = seaFanSurfacePoint(
        seed,
        forkAcross,
        forkProgress,
      );
      appendTaperedSegment(
        positions,
        uvs,
        indices,
        start,
        fork,
        0.012,
        0.004,
        6,
      );
    }
  }
  for (const level of [1, 3] as const) {
    for (let branch = 0; branch < branches - 1; branch += 1) {
      const start = branchNodes[branch]![level]!;
      const end = branchNodes[branch + 1]![level]!;
      if ((branch + level) % 2 === 0) {
        appendTaperedSegment(
          positions,
          uvs,
          indices,
          start,
          end,
          0.0065,
          0.0045,
          6,
        );
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

function seaFanTissueGeometry(seed: number): BufferGeometry {
  const spokes = 25;
  const rings = 7;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const nodes: Vector3[][] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const progress = ring / rings;
    const row: Vector3[] = [];
    for (let spoke = 0; spoke < spokes; spoke += 1) {
      const across = spoke / (spokes - 1) * 2 - 1;
      row.push(seaFanSurfacePoint(seed, across, progress));
    }
    nodes.push(row);
  }

  const tissueColor = new Color();
  const colonyTone = hashedUnit(0, 0, seed ^ 0x7ce4_21b3);
  const colonyHue = 0.925 + colonyTone * 0.12;
  const colonyLightness = 0.39 + colonyTone * 0.105;
  for (let ring = 0; ring <= rings; ring += 1) {
    const progress = ring / rings;
    for (let spoke = 0; spoke < spokes; spoke += 1) {
      const point = nodes[ring]![spoke]!;
      const across = spoke / (spokes - 1);
      const thickness = 0.014
        + hashedUnit(ring, spoke, seed ^ 0xd1f3_75a9) * 0.009
        + progress * 0.004;
      const hue = colonyHue
        + (hashedUnit(ring, spoke, seed ^ 0x7ce4_21b3) - 0.5) * 0.018;
      tissueColor.setHSL(
        hue % 1,
        0.5 + hashedUnit(spoke, ring, seed ^ 0xb529_8d61) * 0.12,
        colonyLightness + progress * 0.035,
      );
      for (const side of [1, -1] as const) {
        positions.push(point.x, point.y, point.z + side * thickness * 0.5);
        uvs.push(across, progress);
        colors.push(tissueColor.r, tissueColor.g, tissueColor.b);
      }
    }
  }
  const front = (ring: number, spoke: number): number => (ring * spokes + spoke) * 2;
  const back = (ring: number, spoke: number): number => front(ring, spoke) + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let spoke = 0; spoke < spokes - 1; spoke += 1) {
      const innerLeft = front(ring, spoke);
      const outerLeft = front(ring + 1, spoke);
      const outerRight = front(ring + 1, spoke + 1);
      const innerRight = front(ring, spoke + 1);
      indices.push(
        innerLeft, outerLeft, outerRight,
        innerLeft, outerRight, innerRight,
        back(ring, spoke), back(ring + 1, spoke + 1), back(ring + 1, spoke),
        back(ring, spoke), back(ring, spoke + 1), back(ring + 1, spoke + 1),
      );
      const innerBoundary = ring === 0;
      const outerBoundary = ring === rings - 1;
      const leftBoundary = spoke === 0;
      const rightBoundary = spoke === spokes - 2;
      if (innerBoundary) indices.push(
        innerLeft, innerRight, back(ring, spoke),
        innerRight, back(ring, spoke + 1), back(ring, spoke),
      );
      if (outerBoundary) indices.push(
        outerLeft, back(ring + 1, spoke), outerRight,
        outerRight, back(ring + 1, spoke), back(ring + 1, spoke + 1),
      );
      if (leftBoundary) indices.push(
        innerLeft, back(ring, spoke), outerLeft,
        outerLeft, back(ring, spoke), back(ring + 1, spoke),
      );
      if (rightBoundary) indices.push(
        innerRight, outerRight, back(ring, spoke + 1),
        outerRight, back(ring + 1, spoke + 1), back(ring, spoke + 1),
      );
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function branchingCoralShape(seed: number, variant: number): BranchingCoralShape {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const polypAnchors: CoralPolypAnchor[] = [];
  const lean = (hashedUnit(variant, 1, seed) - 0.5) * 0.26;
  const twist = (hashedUnit(variant, 2, seed) - 0.5) * 0.22;
  const trunk: Vector3[] = [];
  for (let level = 0; level <= 5; level += 1) {
    const progress = level / 5;
    trunk.push(new Vector3(
      lean * progress + Math.sin(progress * 4.3 + variant) * progress * 0.065,
      progress * 1.5,
      twist * progress + Math.cos(progress * 3.7 + variant * 0.61) * progress * 0.055,
    ));
  }
  for (let segment = 0; segment < trunk.length - 1; segment += 1) {
    appendTaperedSegment(
      positions,
      uvs,
      indices,
      trunk[segment]!,
      trunk[segment + 1]!,
      0.092 - segment * 0.012,
      0.078 - segment * 0.012,
      8,
    );
  }
  const trunkDirection = new Vector3().subVectors(trunk[5]!, trunk[4]!).normalize();
  polypAnchors.push({ position: trunk[5]!.clone(), direction: trunkDirection });
  for (let branchIndex = 0; branchIndex < 9; branchIndex += 1) {
    const level = 1 + branchIndex % 4;
    const start = trunk[level]!;
    const direction = hashedUnit(branchIndex, variant, seed ^ 0x5a27_9c31) < 0.46 ? -1 : 1;
    const spread = 0.38
      + level * 0.075
      + hashedUnit(level, branchIndex, seed ^ variant) * 0.17;
    const depth = (hashedUnit(branchIndex, level, seed ^ 0x51a7_c493) - 0.5) * 0.54;
    const elbow = new Vector3(
      start.x + direction * spread * (0.42 + hashedUnit(branchIndex, 3, seed) * 0.12),
      start.y + 0.12 + hashedUnit(branchIndex, 4, seed) * 0.14,
      start.z + depth * 0.44,
    );
    const tip = new Vector3(
      start.x + direction * spread,
      start.y + 0.31 + level * 0.032 + hashedUnit(branchIndex, 5, seed) * 0.14,
      start.z + depth,
    );
    appendTaperedSegment(
      positions,
      uvs,
      indices,
      start,
      elbow,
      0.059 - level * 0.006,
      0.037 - level * 0.004,
      7,
    );
    appendTaperedSegment(
      positions,
      uvs,
      indices,
      elbow,
      tip,
      0.037 - level * 0.004,
      0.011,
      7,
    );
    const branchDirection = new Vector3().subVectors(tip, elbow).normalize();
    const shoulder = new Vector3().lerpVectors(elbow, tip, 0.68);
    polypAnchors.push(
      { position: shoulder, direction: branchDirection.clone() },
      { position: tip.clone(), direction: branchDirection.clone() },
    );
    const forkDirection = direction * (hashedUnit(branchIndex, 6, seed) < 0.5 ? -1 : 1);
    const fork = new Vector3(
      elbow.x + direction * spread * (0.3 + hashedUnit(branchIndex, 7, seed) * 0.16),
      elbow.y + 0.25 + hashedUnit(branchIndex, 8, seed) * 0.18,
      elbow.z - depth * 0.42 + forkDirection * (0.055 + hashedUnit(branchIndex, 9, seed) * 0.08),
    );
    appendTaperedSegment(
      positions,
      uvs,
      indices,
      elbow,
      fork,
      0.029,
      0.009,
      6,
    );
    polypAnchors.push({
      position: fork.clone(),
      direction: new Vector3().subVectors(fork, elbow).normalize(),
    });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, polypAnchors };
}

function coralPolypGeometry(): SphereGeometry {
  const geometry = new SphereGeometry(0.055, 9, 7);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const progress = y / 0.055 * 0.5 + 0.5;
    const taper = 0.58 + Math.sin(progress * Math.PI) * 0.48;
    positions.setXYZ(index, x * taper, y * 1.62 + 0.055, z * taper);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function bushCoralGeometry(seed: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const branches = 22;
  for (let branch = 0; branch < branches; branch += 1) {
    const angle = branch * 2.399_963_229_728_653
      + (hashedUnit(branch, 0, seed) - 0.5) * 0.34;
    const startRadius = 0.04 + hashedUnit(branch, 1, seed) * 0.12;
    const base = new Vector3(
      Math.cos(angle) * startRadius,
      hashedUnit(branch, 2, seed) * 0.055,
      Math.sin(angle) * startRadius * 0.72,
    );
    const elbowRadius = 0.24 + hashedUnit(branch, 3, seed) * 0.27;
    const elbow = new Vector3(
      Math.cos(angle) * elbowRadius,
      0.25 + hashedUnit(branch, 4, seed) * 0.28,
      Math.sin(angle) * elbowRadius * 0.72,
    );
    const tipAngle = angle + (hashedUnit(branch, 5, seed) - 0.5) * 0.48;
    const tipRadius = 0.48 + hashedUnit(branch, 6, seed) * 0.42;
    const tip = new Vector3(
      Math.cos(tipAngle) * tipRadius,
      0.62 + hashedUnit(branch, 7, seed) * 0.48,
      Math.sin(tipAngle) * tipRadius * 0.76,
    );
    appendTaperedSegment(positions, uvs, indices, base, elbow, 0.034, 0.023, 6);
    appendTaperedSegment(positions, uvs, indices, elbow, tip, 0.023, 0.007, 6);

    const forkAngle = tipAngle + (branch % 2 === 0 ? 0.34 : -0.34)
      + (hashedUnit(branch, 8, seed) - 0.5) * 0.22;
    const forkRadius = tipRadius * (0.78 + hashedUnit(branch, 9, seed) * 0.16);
    const fork = new Vector3(
      Math.cos(forkAngle) * forkRadius,
      elbow.y + 0.28 + hashedUnit(branch, 10, seed) * 0.26,
      Math.sin(forkAngle) * forkRadius * 0.76,
    );
    appendTaperedSegment(positions, uvs, indices, elbow, fork, 0.017, 0.006, 5);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function plateCoralGeometry(seed: number): CylinderGeometry {
  const geometry = new CylinderGeometry(1, 0.7, 0.18, 32, 3, false);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const angle = Math.atan2(z, x);
    const ripple = 0.86
      + Math.sin(angle * 5 + seed * 0.000_019) * 0.08
      + Math.sin(angle * 9 - seed * 0.000_013) * 0.045;
    const radial = Math.hypot(x, z);
    positions.setXYZ(index, x * ripple, y + radial * 0.08, z * ripple);
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
    -0.24, 0, 0,
    -0.1, 0.24, 0.018,
    0.04, 0.37, 0,
    0.2, 0.25, -0.014,
    0.34, 0, 0,
  ], 3));
  geometry.setAttribute("uv", new Float32BufferAttribute([
    0, 0,
    0.28, 0.68,
    0.52, 1,
    0.76, 0.66,
    1, 0,
  ], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 4, 2, 3, 4]);
  geometry.computeVertexNormals();
  return geometry;
}

function fishBodyGeometry(species: number): SphereGeometry {
  const geometry = new SphereGeometry(0.32, 32, 18);
  const positions = geometry.attributes.position;
  const length = species === 0 ? 1.5 : species === 1 ? 0.94 : 1.96;
  const height = species === 0 ? 0.62 : species === 1 ? 1.36 : 0.38;
  const depth = species === 0 ? 0.58 : species === 1 ? 0.34 : 0.36;
  for (let index = 0; index < positions.count; index += 1) {
    const sourceX = positions.getX(index);
    const progress = (sourceX / 0.32 + 1) * 0.5;
    const sourceY = positions.getY(index);
    const sourceZ = positions.getZ(index);
    const shoulder = Math.sin(progress * Math.PI);
    const headShape = progress > 0.7
      ? 1 - (progress - 0.7) / 0.3 * (species === 1 ? 0.08 : 0.16)
      : 1;
    const spine = species === 1
      ? shoulder * 0.042
      : species === 2 ? Math.sin(progress * Math.PI * 1.4) * 0.018 : shoulder * 0.022;
    positions.setXYZ(
      index,
      sourceX * length + (progress > 0.82 ? (progress - 0.82) * 0.08 : 0),
      sourceY * height * headShape + spine,
      sourceZ * depth * (0.84 + shoulder * 0.16),
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function forkedFishTailGeometry(species: number): BufferGeometry {
  const length = species === 0 ? 0.42 : species === 1 ? 0.34 : 0.5;
  const height = species === 0 ? 0.27 : species === 1 ? 0.34 : 0.18;
  const rootHeight = height * 0.3;
  const thickness = species === 1 ? 0.034 : 0.026;
  const outline = [
    [0, rootHeight],
    [-length, height],
    [-length * 0.68, 0],
    [-length, -height],
    [0, -rootHeight],
  ] as const;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const z of [thickness, -thickness]) {
    for (const [x, y] of outline) {
      positions.push(x, y, z);
      uvs.push(1 + x / length, y / (height * 2) + 0.5);
    }
  }
  const indices = [
    0, 1, 2, 0, 2, 4, 4, 2, 3,
    5, 7, 6, 5, 9, 7, 9, 8, 7,
  ];
  for (let edge = 0; edge < outline.length; edge += 1) {
    const next = (edge + 1) % outline.length;
    indices.push(edge, next, edge + 5, next, next + 5, edge + 5);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function organicCoralMoundGeometry(seed: number): SphereGeometry {
  const geometry = new SphereGeometry(0.58, 24, 16);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const longitude = Math.round((Math.atan2(z, x) + Math.PI) * 1_024);
    const latitude = Math.round((y + 0.58) * 2_048);
    const folds = 0.88
      + Math.sin(Math.atan2(z, x) * 7 + seed * 0.000_021) * 0.055
      + hashedUnit(longitude, latitude, seed) * 0.13;
    positions.setXYZ(index, x * folds, y * 0.58, z * folds);
  }
  positions.needsUpdate = true;
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
  readonly #humanArtifactObjects: Object3D[] = [];
  readonly #materials: HeroOwnedMaterial[] = [];
  readonly #geometries: HeroOwnedGeometry[] = [];
  readonly #textures: HeroOwnedTexture[] = [];
  readonly #surfaceTextureLoads: HeroSurfaceTextureLoad[] = [];
  readonly #originalBackground: Scene["background"];
  readonly #originalFog: Scene["fog"];
  readonly #waterGeometry: PlaneGeometry;
  readonly #waterBasePositions: Float32Array;
  readonly #causticsRoot = new Group();
  readonly #ambient: AmbientLight;
  readonly #hemisphere: HemisphereLight;
  readonly #sun: DirectionalLight;
  readonly #coreLight: PointLight;
  readonly #backgroundColor = new Color(0x041d2c);
  readonly #underwaterFog = new FogExp2(0x0a3547, 0.034);
  #state: HeroLifecycle = "new";
  #storyTime = DEFAULT_MARKER_SECONDS;
  #shotId = "S03";
  #qualityTier: RenderQualityProfile["tier"] = "high";
  #initializedAllocations = 0;
  #initializePromise: Promise<void> | null = null;
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
    const reefSurface = this.#surfaceTexturePair(
      "hero-a:photoreal-reef-surface-texture",
      "/assets/gfx/hero-a/reef-seabed-v1.webp",
      5.5,
      4.5,
    );
    const coralClusterSurface = this.#surfaceTexturePair(
      "hero-a:photoreal-coral-cluster-texture",
      "/assets/gfx/hero-a/coral-cluster-v1.webp",
      1,
      1,
    );
    const fishScaleSurface = this.#surfaceTexturePair(
      "hero-a:photoreal-fish-scale-texture",
      "/assets/gfx/hero-a/fish-scales-v1.webp",
      2.8,
      1.8,
    );
    const corrosionTexture = this.#ownTexture(proceduralSurfaceTexture(
      seed ^ 0x75d9_3cbb,
      0x23383c,
      0x74816c,
      3,
      2,
    ));
    corrosionTexture.name = "hero-a:vehicle-corrosion-texture";
    const corrosionHeightTexture = this.#ownTexture(proceduralHeightTexture(
      seed ^ 0x5ca1_8e73,
      3,
      2,
    ));
    corrosionHeightTexture.name = "hero-a:vehicle-linear-height-texture";
    const organicDetailTexture = this.#ownTexture(proceduralSurfaceTexture(
      seed ^ 0xe1b7_45d3,
      0x7f9185,
      0xf0f3e7,
      9,
      11,
    ));
    organicDetailTexture.name = "hero-a:organic-surface-detail-texture";
    const organicHeightTexture = this.#ownTexture(proceduralHeightTexture(
      seed ^ 0x8d42_6af1,
      9,
      11,
    ));
    organicHeightTexture.name = "hero-a:organic-linear-height-texture";
    const causticMaskTexture = this.#ownTexture(proceduralCausticMaskTexture(
      seed ^ 0xa63d_51e8,
    ));
    causticMaskTexture.name = "hero-a:caustic-linear-mask-texture";
    const hazeMaskTexture = this.#ownTexture(proceduralHazeMaskTexture(
      seed ^ 0x7a36_19c4,
    ));
    hazeMaskTexture.name = "hero-a:haze-linear-mask-texture";

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

    this.#ambient = new AmbientLight(0x70aab8, 0.27);
    this.#ambient.name = "hero-a:underwater-ambient";
    this.#hemisphere = new HemisphereLight(0xb2e0e6, 0x17342c, 0.88);
    this.#hemisphere.name = "hero-a:water-column-light";
    this.#sun = new DirectionalLight(0xe9fbff, 5.4);
    this.#sun.name = "hero-a:surface-sun";
    this.#sun.position.set(-6, 13, 8);
    this.#coreLight = new PointLight(0xffdda0, 2.25, 5.5, 1.7);
    this.#coreLight.name = "hero-a:living-core-light";
    this.#protagonistRoot.add(this.#coreLight);
    this.#scene.add(this.#ambient, this.#hemisphere, this.#sun);

    const terrain = this.#ownMaterial(standardMaterial(0x466d61, 0.9));
    const sand = this.#ownMaterial(standardMaterial(0x788c7a, 0.86));
    const seafloor = this.#ownMaterial(standardMaterial(0xffffff, 0.9));
    seafloor.vertexColors = true;
    seafloor.map = reefSurface.map;
    seafloor.bumpMap = reefSurface.bumpMap;
    seafloor.bumpScale = 0.22;
    const waterColumn = this.#ownMaterial(new MeshBasicNodeMaterial());
    waterColumn.color.setHex(0xffffff);
    waterColumn.vertexColors = true;
    waterColumn.side = BackSide;
    waterColumn.toneMapped = false;
    const coralRose = this.#ownMaterial(standardMaterial(0x8d4d59, 0.72));
    const coralGold = this.#ownMaterial(standardMaterial(0x9f7948, 0.74));
    const coralLilac = this.#ownMaterial(standardMaterial(0x625982, 0.7));
    const kelpMaterial = this.#ownMaterial(standardMaterial(0x104b38, 0.82));
    const fishSilver = this.#ownMaterial(physicalMaterial(0x6f9fa0, 0.4, 0.06, 1.34));
    const fishCoral = this.#ownMaterial(physicalMaterial(0xb96855, 0.48, 0.02, 1.34));
    const fishGold = this.#ownMaterial(physicalMaterial(0xa89258, 0.44, 0.04, 1.34));
    coralRose.emissive.setHex(0x26070d);
    coralRose.emissiveIntensity = 0.42;
    coralGold.emissive.setHex(0x291704);
    coralGold.emissiveIntensity = 0.38;
    coralLilac.emissive.setHex(0x120925);
    coralLilac.emissiveIntensity = 0.4;
    coralRose.map = organicDetailTexture;
    coralRose.bumpMap = coralClusterSurface.bumpMap;
    coralRose.bumpScale = 0.024;
    coralRose.side = DoubleSide;
    coralGold.map = organicDetailTexture;
    coralGold.bumpMap = organicHeightTexture;
    coralGold.bumpScale = 0.05;
    coralGold.side = DoubleSide;
    coralLilac.map = organicDetailTexture;
    coralLilac.bumpMap = organicHeightTexture;
    coralLilac.bumpScale = 0.05;
    coralLilac.side = DoubleSide;
    const seaFanTissueMaterial = this.#ownMaterial(standardMaterial(0xffffff, 0.76));
    seaFanTissueMaterial.vertexColors = true;
    seaFanTissueMaterial.bumpMap = coralClusterSurface.bumpMap;
    seaFanTissueMaterial.bumpScale = 0.032;
    seaFanTissueMaterial.side = DoubleSide;
    seaFanTissueMaterial.emissive.setHex(0x2a0d14);
    seaFanTissueMaterial.emissiveIntensity = 0.08;
    kelpMaterial.map = organicDetailTexture;
    kelpMaterial.bumpMap = organicHeightTexture;
    kelpMaterial.bumpScale = 0.025;
    kelpMaterial.side = DoubleSide;
    fishSilver.map = fishScaleSurface.map;
    fishSilver.bumpMap = fishScaleSurface.bumpMap;
    fishSilver.bumpScale = 0.026;
    fishCoral.map = fishScaleSurface.map;
    fishCoral.bumpMap = fishScaleSurface.bumpMap;
    fishCoral.bumpScale = 0.026;
    fishGold.map = fishScaleSurface.map;
    fishGold.bumpMap = fishScaleSurface.bumpMap;
    fishGold.bumpScale = 0.026;
    for (const fishMaterial of [fishSilver, fishCoral, fishGold]) {
      fishMaterial.clearcoat = 0.42;
      fishMaterial.clearcoatRoughness = 0.26;
      fishMaterial.iridescence = 0.1;
      fishMaterial.iridescenceIOR = 1.23;
      fishMaterial.iridescenceThicknessRange = [80, 180];
    }
    fishSilver.side = DoubleSide;
    fishCoral.side = DoubleSide;
    fishGold.side = DoubleSide;
    const vehicleMetal = this.#ownMaterial(standardMaterial(0x273a42, 0.67, 0.62));
    const vehiclePanel = this.#ownMaterial(standardMaterial(0x42565b, 0.82, 0.18));
    const darkSeat = this.#ownMaterial(standardMaterial(0x6a7770, 0.91, 0.06));
    darkSeat.emissive.setHex(0x07100e);
    darkSeat.emissiveIntensity = 0.16;
    const interiorVoid = this.#ownMaterial(standardMaterial(0x071116, 0.98, 0.04));
    const vehicleGlass = this.#ownMaterial(physicalMaterial(0x4a92a0, 0.28, 0.16, 1.45));
    terrain.map = reefSurface.map;
    terrain.bumpMap = reefSurface.bumpMap;
    terrain.bumpScale = 0.18;
    sand.map = reefSurface.map;
    sand.bumpMap = reefSurface.bumpMap;
    sand.bumpScale = 0.12;
    vehicleMetal.map = corrosionTexture;
    vehicleMetal.bumpMap = corrosionHeightTexture;
    vehicleMetal.bumpScale = 0.08;
    vehiclePanel.map = corrosionTexture;
    vehiclePanel.bumpMap = corrosionHeightTexture;
    vehiclePanel.bumpScale = 0.06;
    const waterMaterial = this.#ownMaterial(physicalMaterial(0x6fbfc7, 0.24, 0.18, 1.333));
    const surfaceSheenMaterial = this.#ownMaterial(additiveMaterial(0xb9f7f4, 0.028));
    const bubbleMaterial = this.#ownMaterial(physicalMaterial(0xa5f5ff, 0.28, 0.08, 1.333));
    const causticMaterial = this.#ownMaterial(additiveMaterial(0xd7fff2, 0.16));
    const shaftMaterial = this.#ownMaterial(additiveMaterial(0x75dcff, 0.09));
    shaftMaterial.alphaMap = hazeMaskTexture;
    const hazeMaterial = this.#ownMaterial(additiveMaterial(0x3b9caf, 0.065));
    hazeMaterial.alphaMap = hazeMaskTexture;
    const coreMaterial = this.#ownMaterial(additiveMaterial(0xfff5ce, 0.98));
    const envelopeMaterial = this.#ownMaterial(physicalMaterial(0xa9f1f1, 0.52, 0.12, 1.333));
    const pulseMaterial = this.#ownMaterial(additiveMaterial(0x9fffe7, 0.34));
    vehicleGlass.thickness = 0.16;
    vehicleGlass.clearcoat = 1;
    waterMaterial.thickness = 0.62;
    waterMaterial.clearcoat = 1;
    waterMaterial.clearcoatRoughness = 0.09;
    waterMaterial.iridescence = 0.12;
    waterMaterial.iridescenceIOR = 1.28;
    waterMaterial.emissive.setHex(0x285f68);
    waterMaterial.emissiveIntensity = 0.46;
    waterMaterial.bumpMap = causticMaskTexture;
    waterMaterial.bumpScale = 0.04;
    surfaceSheenMaterial.alphaMap = causticMaskTexture;
    bubbleMaterial.thickness = 0.08;
    bubbleMaterial.iridescence = 0.32;
    bubbleMaterial.iridescenceIOR = 1.25;
    envelopeMaterial.thickness = 0.48;
    envelopeMaterial.clearcoat = 1;
    envelopeMaterial.iridescence = 0.58;
    envelopeMaterial.iridescenceIOR = 1.24;
    envelopeMaterial.iridescenceThicknessRange = [110, 360];
    causticMaterial.alphaMap = causticMaskTexture;
    causticMaterial.polygonOffset = true;
    causticMaterial.polygonOffsetFactor = -1;
    causticMaterial.polygonOffsetUnits = -1;

    const dome = new Mesh(this.#ownGeometry(underwaterDomeGeometry()), waterColumn);
    dome.name = "hero-a:water-column-gradient-dome";
    dome.position.y = -4;
    this.#naturalRoot.add(dome);

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

    const waterGeometry = this.#waterGeometry = this.#ownGeometry(new PlaneGeometry(38, 28, 48, 32));
    this.#waterBasePositions = new Float32Array(waterGeometry.attributes.position.array as ArrayLike<number>);
    const water = new Mesh(waterGeometry, waterMaterial);
    water.name = "hero-a:ocean-surface";
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 4.6, -2);
    water.renderOrder = 4;
    const waterSheen = new Mesh(waterGeometry, surfaceSheenMaterial);
    waterSheen.name = "hero-a:ocean-surface-caustic-sheen";
    waterSheen.rotation.x = -Math.PI / 2;
    waterSheen.position.set(0, 4.635, -2);
    waterSheen.renderOrder = 5;
    this.#naturalRoot.add(water, waterSheen);

    for (const side of [-1, 1] as const) {
      const shelf = new Mesh(
        this.#ownGeometry(reefShelfGeometry(seed ^ 0x73e1_4a9d, side)),
        seafloor,
      );
      shelf.name = side < 0 ? "hero-a:organic-reef-shelf:left" : "hero-a:organic-reef-shelf:right";
      shelf.renderOrder = 0;
      this.#naturalRoot.add(shelf);
    }

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

    const reefWallSpecs = Object.freeze([
      [-10.2, -1.62, 3.35, 2.8, 1.92, 1.75],
      [-8.45, -2.02, 1.5, 2.35, 1.22, 1.72],
      [-8.9, -0.98, -1.35, 1.85, 1.92, 1.55],
      [-7.25, -2.22, -3.4, 2.1, 0.92, 1.7],
      [10.2, -1.58, 3.2, 2.85, 2.02, 1.78],
      [8.35, -1.98, 1.4, 2.38, 1.28, 1.76],
      [8.9, -0.9, -1.45, 1.9, 1.98, 1.58],
      [7.1, -2.2, -3.55, 2.14, 0.94, 1.72],
    ] as const);
    for (let index = 0; index < reefWallSpecs.length; index += 1) {
      const [x, y, z, scaleX, scaleY, scaleZ] = reefWallSpecs[index]!;
      const wall = new Mesh(
        rockGeometries[index % rockGeometries.length]!,
        index % 3 === 1 ? sand : terrain,
      );
      wall.name = `hero-a:foreground-reef-wall:${index}`;
      wall.position.set(x, y, z);
      wall.rotation.set(
        (index % 3 - 1) * 0.08,
        index * 0.47,
        (index % 4 - 1.5) * 0.055,
      );
      setScale(wall, scaleX, scaleY, scaleZ);
      this.#naturalRoot.add(wall);
    }

    const branchingCoralShapes = Array.from({ length: 5 }, (_, variant) => {
      const shape = branchingCoralShape(seed ^ 0x4b71_29d3, variant);
      this.#ownGeometry(shape.geometry);
      return shape;
    });
    const coralPolypMeshGeometry = this.#ownGeometry(coralPolypGeometry());
    coralPolypMeshGeometry.name = "hero-a:branch-attached-coral-polyp-geometry";
    const coralPolypDummy = new Object3D();
    const fanPolypDummy = new Object3D();
    const coralPolypColor = new Color();
    const coralPolypUp = new Vector3(0, 1, 0);
    const coralMoundGeometries = [
      this.#ownGeometry(organicCoralMoundGeometry(seed ^ 0x148c_6d91)),
      this.#ownGeometry(organicCoralMoundGeometry(seed ^ 0x5ea3_28b7)),
      this.#ownGeometry(organicCoralMoundGeometry(seed ^ 0x83d1_74c5)),
    ];
    const bushCoralGeometries = [
      this.#ownGeometry(bushCoralGeometry(seed ^ 0x78a4_31d5)),
      this.#ownGeometry(bushCoralGeometry(seed ^ 0x19ce_64b2)),
      this.#ownGeometry(bushCoralGeometry(seed ^ 0xc531_8a7d)),
    ];
    const seaFanSeeds = [
      seed ^ 0x6ea1_85c7,
      seed ^ 0xb428_37d1,
      seed ^ 0x31d5_9a6f,
      seed ^ 0xc684_2d39,
      seed ^ 0x58f1_b7a4,
      seed ^ 0x9a37_64e2,
      seed ^ 0x247d_c851,
    ] as const;
    const seaFanGeometries = seaFanSeeds.map((fanSeed) => (
      this.#ownGeometry(seaFanGeometry(fanSeed))
    ));
    const seaFanTissueGeometries = seaFanSeeds.map((fanSeed) => (
      this.#ownGeometry(seaFanTissueGeometry(fanSeed))
    ));
    const plateCoralGeometries = [
      this.#ownGeometry(plateCoralGeometry(seed ^ 0x295c_71e4)),
      this.#ownGeometry(plateCoralGeometry(seed ^ 0x8bd1_43a6)),
      this.#ownGeometry(plateCoralGeometry(seed ^ 0xc13a_5f82)),
    ];
    const moundRandom = randomFrom(seed ^ 0xb73e_4529);
    const coralMaterials = [coralRose, coralGold, coralLilac];
    const coralClusterAnchors = Object.freeze([
      [-8.9, 1.4], [-6.45, 0.75], [-4.55, -0.6], [5.15, 0.85], [7.35, 1.55],
      [9.1, -0.35], [-8.55, -2.8], [-6.2, -3.55], [-4.05, -4.25], [4.35, -3.4],
      [6.55, -3.9], [8.45, -4.75], [-7.2, -7.15], [-4.85, -6.8], [-2.75, -7.55],
      [2.75, -6.95], [4.9, -7.65], [7.15, -7.1], [-1.15, -4.95], [1.25, -5.25],
    ] as const);
    for (let clusterIndex = 0; clusterIndex < 20; clusterIndex += 1) {
      const cluster = new Group();
      cluster.name = `hero-a:coral-cluster:${clusterIndex}`;
      const [anchorX, anchorZ] = coralClusterAnchors[clusterIndex]!;
      cluster.position.set(anchorX, -2.85, anchorZ);
      const depthScale = anchorZ > 0 ? 1.32 : anchorZ < -6 ? 0.76 : 1;
      cluster.scale.setScalar(depthScale);
      const material = coralMaterials[clusterIndex % coralMaterials.length]!;
      const species = clusterIndex % 3;
      if (species === 0) {
        for (let moundIndex = 0; moundIndex < 3; moundIndex += 1) {
          const mound = new Mesh(
            coralMoundGeometries[(clusterIndex + moundIndex) % coralMoundGeometries.length]!,
            coralMaterials[(clusterIndex + moundIndex + 1) % coralMaterials.length]!,
          );
          mound.name = `hero-a:coral-organic-mound:${clusterIndex}:${moundIndex}`;
          mound.position.set(
            (moundIndex - 1) * 0.46 + moundRandom.range(-0.08, 0.08),
            0.18 + (moundIndex % 2) * 0.08,
            moundRandom.range(-0.34, 0.34),
          );
          mound.rotation.set(
            moundRandom.range(-0.18, 0.18),
            moundRandom.range(0, TAU),
            moundRandom.range(-0.12, 0.12),
          );
          setScale(
            mound,
            moundRandom.range(0.72, 1.12),
            moundRandom.range(0.68, 1.04),
            moundRandom.range(0.72, 1.14),
          );
          cluster.add(mound);
        }
      }
      if (species === 1) {
        const fanMaterial = coralRose;
        const fanVariantIndex = clusterIndex % seaFanSeeds.length;
        const fanSeed = seaFanSeeds[fanVariantIndex]!;
        const fan = new Mesh(
          seaFanGeometries[fanVariantIndex]!,
          fanMaterial,
        );
        fan.name = `hero-a:coral-sea-fan:${clusterIndex}`;
        fan.position.set(0, 0.04, 0);
        fan.rotation.set(
          moundRandom.range(-0.16, 0.16),
          moundRandom.range(-0.95, 0.95),
          moundRandom.range(-0.28, 0.28),
        );
        setScale(
          fan,
          moundRandom.range(0.92, 1.24),
          moundRandom.range(1.08, 1.48),
          1,
        );
        const tissue = new Mesh(
          seaFanTissueGeometries[fanVariantIndex]!,
          seaFanTissueMaterial,
        );
        tissue.name = `hero-a:coral-sea-fan-tissue:${clusterIndex}:front`;
        tissue.position.copy(fan.position);
        tissue.rotation.copy(fan.rotation);
        tissue.scale.copy(fan.scale);
        tissue.renderOrder = 0;
        const fanPolyps = new InstancedMesh(coralPolypMeshGeometry, fanMaterial, 12);
        fanPolyps.name = `hero-a:sea-fan-edge-polyps:${clusterIndex}`;
        for (let polypIndex = 0; polypIndex < 12; polypIndex += 1) {
          const patchIndex = Math.floor(polypIndex / 4);
          const patchCenter = patchIndex === 0 ? -0.62 : patchIndex === 1 ? -0.04 : 0.58;
          const patchOffset = (polypIndex % 4 - 1.5) * 0.09
            + (hashedUnit(clusterIndex, polypIndex, seed ^ 0xc279_51e4) - 0.5) * 0.045;
          const across = Math.max(-0.94, Math.min(0.94, patchCenter + patchOffset));
          const progress = 0.78
            + hashedUnit(polypIndex, clusterIndex, seed ^ 0x3f91_a627) * 0.2;
          const polypPoint = seaFanSurfacePoint(fanSeed, across, progress);
          fanPolypDummy.position.copy(polypPoint);
          fanPolypDummy.position.z += 0.018;
          fanPolypDummy.quaternion.setFromUnitVectors(
            coralPolypUp,
            new Vector3(across * 0.18, 1, fanPolypDummy.position.z * 0.4).normalize(),
          );
          const fanPolypScale = 0.3
            + hashedUnit(polypIndex, clusterIndex, seed ^ 0x7b14_5ca9) * 0.22;
          fanPolypDummy.scale.setScalar(fanPolypScale);
          fanPolypDummy.updateMatrix();
          fanPolyps.setMatrixAt(polypIndex, fanPolypDummy.matrix);
        }
        fanPolyps.instanceMatrix.needsUpdate = true;
        fan.add(fanPolyps);
        fan.renderOrder = 1;
        cluster.add(tissue, fan);
      }
      if (species === 2) {
        for (let plateIndex = 0; plateIndex < 3; plateIndex += 1) {
          const plate = new Mesh(
            plateCoralGeometries[(clusterIndex + plateIndex) % plateCoralGeometries.length]!,
            coralMaterials[(clusterIndex + plateIndex) % coralMaterials.length]!,
          );
          plate.name = `hero-a:coral-table-plate:${clusterIndex}:${plateIndex}`;
          plate.position.set(
            (plateIndex - 1) * 0.2,
            0.18 + plateIndex * 0.32,
            (plateIndex % 2 - 0.5) * 0.18,
          );
          plate.rotation.set(
            moundRandom.range(-0.08, 0.08),
            moundRandom.range(0, TAU),
            moundRandom.range(-0.06, 0.06),
          );
          const plateScale = 1.08 - plateIndex * 0.18;
          setScale(plate, plateScale, 1, plateScale * moundRandom.range(0.82, 1.1));
          cluster.add(plate);
        }
      }
      const branchingShape = branchingCoralShapes[clusterIndex % branchingCoralShapes.length]!;
      const architecture = new Mesh(branchingShape.geometry, material);
      architecture.name = `hero-a:continuous-branch-coral:${clusterIndex}`;
      architecture.position.set(
        species === 1 ? -0.08 : species === 2 ? 0.16 : 0,
        0.04,
        species === 1 ? 0.08 : -0.06,
      );
      architecture.rotation.set(
        moundRandom.range(-0.08, 0.08),
        moundRandom.range(-0.6, 0.6),
        moundRandom.range(-0.16, 0.16),
      );
      const architectureScale = species === 0
        ? moundRandom.range(0.82, 1.08)
        : species === 1 ? moundRandom.range(0.58, 0.78) : moundRandom.range(0.66, 0.9);
      setScale(
        architecture,
        architectureScale * moundRandom.range(0.88, 1.14),
        architectureScale * moundRandom.range(0.94, 1.18),
        architectureScale * moundRandom.range(0.82, 1.12),
      );
      const bush = new Mesh(
        bushCoralGeometries[clusterIndex % bushCoralGeometries.length]!,
        coralMaterials[(clusterIndex + 2) % coralMaterials.length]!,
      );
      bush.name = `hero-a:dense-bush-coral:${clusterIndex}`;
      bush.position.set(
        species === 0 ? 0.34 : species === 1 ? 0.22 : -0.3,
        0.06,
        species === 1 ? -0.08 : 0.12,
      );
      bush.rotation.set(
        moundRandom.range(-0.1, 0.1),
        moundRandom.range(-0.7, 0.7),
        moundRandom.range(-0.12, 0.12),
      );
      const bushScale = species === 1
        ? moundRandom.range(0.64, 0.82)
        : species === 2 ? moundRandom.range(0.58, 0.76) : moundRandom.range(0.72, 0.92);
      setScale(
        bush,
        bushScale * moundRandom.range(0.92, 1.16),
        bushScale * moundRandom.range(0.84, 1.08),
        bushScale * moundRandom.range(0.9, 1.14),
      );
      const polypCount = species === 2 ? 24 : 28;
      const polyps = new InstancedMesh(coralPolypMeshGeometry, material, polypCount);
      polyps.name = `hero-a:volumetric-coral-polyps:${clusterIndex}`;
      for (let polypIndex = 0; polypIndex < polypCount; polypIndex += 1) {
        const anchor = branchingShape.polypAnchors[
          (polypIndex * 7 + clusterIndex) % branchingShape.polypAnchors.length
        ]!;
        coralPolypDummy.position.copy(anchor.position);
        coralPolypDummy.position.addScaledVector(anchor.direction, moundRandom.range(-0.004, 0.018));
        coralPolypDummy.quaternion.setFromUnitVectors(coralPolypUp, anchor.direction);
        coralPolypDummy.rotateY(moundRandom.range(-0.35, 0.35));
        const polypScale = moundRandom.range(0.46, 0.78);
        coralPolypDummy.scale.set(
          polypScale * moundRandom.range(0.82, 1.12),
          polypScale * moundRandom.range(0.92, 1.28),
          polypScale * moundRandom.range(0.82, 1.12),
        );
        coralPolypDummy.updateMatrix();
        polyps.setMatrixAt(polypIndex, coralPolypDummy.matrix);
        const hue = species === 0 ? 0.97 : species === 1 ? 0.1 : 0.76;
        coralPolypColor.setHSL(
          hue + moundRandom.range(-0.035, 0.035),
          moundRandom.range(0.24, 0.48),
          moundRandom.range(0.48, 0.68),
        );
        polyps.setColorAt(polypIndex, coralPolypColor);
      }
      polyps.instanceMatrix.needsUpdate = true;
      if (polyps.instanceColor) polyps.instanceColor.needsUpdate = true;
      cluster.add(bush, architecture, polyps);
      this.#coralClusters.push(cluster);
      this.#naturalRoot.add(cluster);
    }

    const kelpBladeGeometries = [
      this.#ownGeometry(kelpBladeGeometry(0.35)),
      this.#ownGeometry(kelpBladeGeometry(2.1)),
    ];
    for (let index = 0; index < 18; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const row = Math.floor(index / 2);
      const baseZ = 1.75 - row * 1.12 + random.range(-0.22, 0.22);
      const baseX = side * random.range(4.1, 9.4);
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
      const kelpDepthScale = baseZ > 0.5 ? 1.28 : baseZ < -5.5 ? 0.76 : 1;
      group.scale.setScalar(kelpDepthScale);
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

    const fishBodyGeometries = [
      this.#ownGeometry(fishBodyGeometry(0)),
      this.#ownGeometry(fishBodyGeometry(1)),
      this.#ownGeometry(fishBodyGeometry(2)),
    ];
    const fishTailGeometries = [
      this.#ownGeometry(forkedFishTailGeometry(0)),
      this.#ownGeometry(forkedFishTailGeometry(1)),
      this.#ownGeometry(forkedFishTailGeometry(2)),
    ];
    const fishFin = this.#ownGeometry(fishFinGeometry());
    const fishMaterials = [fishSilver, fishCoral, fishGold] as const;
    for (let index = 0; index < 28; index += 1) {
      const group = new Group();
      group.name = `hero-a:fish:${index}`;
      const species = index % 3;
      const material = fishMaterials[species]!;
      const body = new Mesh(fishBodyGeometries[species]!, material);
      body.name = `hero-a:fish-body:${index}:species-${species}`;
      const tail = new Mesh(fishTailGeometries[species]!, material);
      tail.name = `hero-a:fish-forked-tail:${index}`;
      tail.position.x = species === 0 ? -0.43 : species === 1 ? -0.27 : -0.57;
      const dorsal = new Mesh(fishFin, material);
      dorsal.name = `hero-a:fish-dorsal-fin:${index}`;
      dorsal.position.set(species === 2 ? -0.08 : -0.02, species === 1 ? 0.24 : 0.14, 0);
      setScale(
        dorsal,
        species === 2 ? 0.9 : 0.72,
        species === 1 ? 1.08 : species === 2 ? 0.38 : 0.62,
        0.72,
      );
      const anal = new Mesh(fishFin, material);
      anal.name = `hero-a:fish-anal-fin:${index}`;
      anal.position.set(species === 2 ? -0.14 : -0.08, species === 1 ? -0.23 : -0.13, 0);
      anal.rotation.z = Math.PI;
      setScale(
        anal,
        species === 2 ? 0.62 : 0.54,
        species === 1 ? 0.82 : species === 2 ? 0.32 : 0.48,
        0.68,
      );
      const leftFin = new Mesh(fishFin, material);
      const rightFin = new Mesh(fishFin, material);
      leftFin.name = `hero-a:fish-pectoral-fin:${index}:left`;
      rightFin.name = `hero-a:fish-pectoral-fin:${index}:right`;
      const finZ = species === 1 ? 0.06 : 0.09;
      leftFin.position.set(0.02, -0.035, finZ);
      rightFin.position.set(0.02, -0.035, -finZ);
      leftFin.rotation.x = Math.PI / 2;
      rightFin.rotation.x = -Math.PI / 2;
      const pectoralScale = species === 1 ? 0.76 : species === 2 ? 0.42 : 0.58;
      setScale(leftFin, pectoralScale, pectoralScale * 0.82, pectoralScale);
      setScale(rightFin, pectoralScale, pectoralScale * 0.82, pectoralScale);
      group.add(body, tail, dorsal, anal, leftFin, rightFin);
      const scale = (index < 16
        ? random.range(0.26, 0.52)
        : index < 24 ? random.range(0.52, 0.86) : random.range(0.72, 1.04))
        * random.range(0.9, 1.08);
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
      const radius = random.range(0.36, 1.05);
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

    const hazeGeometry = this.#ownGeometry(new PlaneGeometry(13, 8, 1, 1));
    for (let index = 0; index < 4; index += 1) {
      const haze = new Mesh(hazeGeometry, hazeMaterial);
      haze.name = `hero-a:volumetric-haze-layer:${index}`;
      haze.position.set((index % 2 === 0 ? -1 : 1) * 1.7, 0.2 + index * 0.12, -1.2 - index * 2.35);
      haze.rotation.z = (index - 1.5) * 0.11;
      setScale(haze, 1 + index * 0.12, 0.92 + index * 0.09, 1);
      haze.renderOrder = -1;
      this.#naturalRoot.add(haze);
    }

    const shaftGeometry = this.#ownGeometry(new PlaneGeometry(2.8, 12, 1, 1));
    for (let index = 0; index < 5; index += 1) {
      const shaft = new Mesh(shaftGeometry, shaftMaterial);
      shaft.name = `hero-a:light-shaft:${index}`;
      shaft.position.set(-7 + index * 3.5, 1.9, -5 - (index % 2) * 2);
      shaft.rotation.z = (index - 2) * 0.05;
      setScale(shaft, 0.76 + (index % 2) * 0.22, 1, 1);
      this.#naturalRoot.add(shaft);
    }

    this.#buildProtagonist(envelopeMaterial, coreMaterial);
    this.#protagonistRoot.scale.setScalar(0.36);
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
    this.#captureHumanArtifactObjects();
    this.#setHumanArtifactsVisible(false);
    this.#buildWaterline(bubbleMaterial);

    // Keep all non-human topology visible through compile-before-ready. The
    // fully attached and preallocated human graph starts at the exact default
    // 12-second state so the warm-up canvas cannot disclose it before update.
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
    if (this.#initializePromise) return this.#initializePromise;
    const attempt = this.#loadSurfaceTextures().then(() => {
      if (this.#state === "disposed" || this.#state === "disposing") {
        throw new Error("Ocean Hero feature was disposed during initialization.");
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
    const underwater = this.#storyTime < WATERLINE_SECONDS + 1.4;
    const revealVehicle = this.#storyTime >= HUMAN_REVEAL_SECONDS && this.#storyTime < WATERLINE_SECONDS;
    this.#setHumanArtifactsVisible(revealVehicle);
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
        0.008 + transition * 0.052,
        0.07 + deep * 0.026 + transition * 0.17,
        0.12 + deep * 0.042 + transition * 0.23,
      );
      this.#underwaterFog.color.setHex(transition > 0.45 ? 0x20596a : 0x0a3547);
      this.#underwaterFog.density = 0.034 - transition * 0.012;
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
          throw new Error(`Could not load Hero A surface texture ${entry.url}.`);
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
        throw new Error("Ocean Hero feature was disposed while loading surface textures.");
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
    const ringGeometry = this.#ownGeometry(new TorusGeometry(1.02, 0.032, 8, 64));
    const ring = new Mesh(ringGeometry, pulse);
    ring.name = "hero-a:pulse-wave";
    ring.rotation.x = Math.PI / 2;
    this.#pulseRoot.add(ring);
    const targetGeometry = this.#ownGeometry(new IcosahedronGeometry(0.48, 2));
    const bud = new Mesh(targetGeometry, coralGold);
    bud.name = "hero-a:pulse-living-target";
    setScale(bud, 0.58, 0.9, 0.58);
    const bloom = new Mesh(targetGeometry, coralRose);
    bloom.name = "hero-a:pulse-new-life-bloom";
    bloom.position.set(0, 0.65, 0);
    setScale(bloom, 0.5, 0.34, 0.5);
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

  #buildWaterline(bubble: Material): void {
    const bubbleGeometry = this.#ownGeometry(new SphereGeometry(0.055, 9, 7));
    for (let index = 0; index < 18; index += 1) {
      const angle = (index / 18) * TAU;
      const radius = 0.9 + (index % 6) * 0.38;
      const waterBubble = new Mesh(bubbleGeometry, bubble);
      waterBubble.name = `hero-a:waterline-bubble:${index}`;
      waterBubble.position.set(
        Math.cos(angle) * radius,
        4.48 + Math.sin(index * 1.9) * 0.17,
        -1 + Math.sin(angle) * radius * 0.8,
      );
      waterBubble.scale.setScalar(0.38 + (index % 4) * 0.13);
      this.#waterlineRoot.add(waterBubble);
    }
  }

  #captureHumanArtifactObjects(): void {
    this.#vehicleRoot.traverse((object) => {
      this.#humanArtifactObjects.push(object);
    });
  }

  #setHumanArtifactsVisible(visible: boolean): void {
    for (let index = 0; index < this.#humanArtifactObjects.length; index += 1) {
      this.#humanArtifactObjects[index]!.visible = visible;
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
      const wave = Math.sin(x * 0.31 + time * 0.64) * 0.095
        + Math.sin(y * 0.47 - time * 0.42) * 0.055
        + Math.cos((x + y) * 0.16 + time * 0.28) * 0.032;
      positions.setZ(index, wave);
    }
    positions.needsUpdate = true;
    this.#waterGeometry.computeVertexNormals();
  }

  #animateFish(time: number): void {
    for (let index = 0; index < this.#fish.length; index += 1) {
      const entry = this.#fish[index]!;
      const distant = index < 16;
      const foreground = index >= 24;
      const travelWidth = distant ? 12 : foreground ? 18 : 15;
      const travel = ((time * entry.speed + entry.phase) % travelWidth) - travelWidth * 0.5;
      const direction = index % 4 === 0 ? -1 : 1;
      const depth = distant
        ? -6.7 - (index % 4) * 0.58
        : foreground ? -0.72 - (index % 2) * 0.78 : -3.2 - (index % 4) * 0.62;
      entry.group.position.set(
        travel * direction,
        (distant ? 0.35 : foreground ? -0.1 : -0.45)
          + entry.lane * (distant ? 1.25 : foreground ? 1.7 : 1.5)
          + Math.sin(time * 0.7 + entry.phase) * 0.18,
        depth + Math.cos(entry.phase + time * 0.19) * (distant ? 0.18 : 0.32),
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
      1.55 + reveal * 2.55 + frame.position.x * 1.9 + Math.sin(time * 0.55) * 0.14,
      0.15 + surface * 4.25 + frame.position.y * 1.7 + Math.sin(time * 0.88) * 0.12,
      1.8 + Math.cos(time * 0.31) * 0.08,
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
    const scale = 0.58 + cycle * 1.18;
    ring.scale.setScalar(scale);
    ring.rotation.z = time * 0.12;
  }

  #cameraForStory(storyTime: number, transition: number, inputX: number, inputY: number): void {
    if (storyTime < HUMAN_REVEAL_SECONDS) {
      this.#camera.position.set(0.15 + inputX * 0.34, 0.15 + inputY * 0.24, 9.35);
      this.#camera.lookAt(0.15, -0.95, -2.35);
      return;
    }
    if (storyTime < WATERLINE_SECONDS) {
      const reveal = Math.min(1, (storyTime - HUMAN_REVEAL_SECONDS) / 9);
      this.#camera.position.set(0.55 + reveal * 3.25 + inputX * 0.28, 0.42 + reveal * 0.52, 9.8 - reveal * 0.8);
      this.#camera.lookAt(-0.25, -0.72, -3.8);
      return;
    }
    this.#camera.position.set(
      4.55 - transition * 3.2,
      1.15 + transition * 5.9,
      9.9 - transition * 2.5,
    );
    this.#camera.lookAt(0, 3.08 + transition * 0.72, -1.4);
  }

  #ownedObjectCount(): number {
    let count = 0;
    this.#root.traverse((object) => {
      if (object !== this.#root) count += 1;
    });
    return this.#state === "disposed" ? 0 : count + 3;
  }
}
