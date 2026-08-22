import * as THREE from "three";
import { mixSeed, mulberry32 } from "./procedural";
import type { QualityLevel } from "./model";

/**
 * Renderer-only asset vocabulary derived from the Notion gameplay galleries.
 * None of these helpers read inputs or write simulation state: `seed` only
 * chooses a reproducible visual arrangement and `quality` only changes mesh
 * density.  Callers own the returned group and may animate transforms freely.
 */
export interface VisualAssetOptions {
  seed: number;
  quality?: QualityLevel;
}

export interface VisualLighting {
  readonly group: THREE.Group;
  readonly key: "natural-lighting";
}

const DETAIL: Record<QualityLevel, number> = { low: 0.42, balanced: 0.7, high: 1 };

function qualityOf(options: VisualAssetOptions): QualityLevel {
  return options.quality ?? "balanced";
}

function countFor(options: VisualAssetOptions, low: number, high: number): number {
  return Math.max(low, Math.round(low + (high - low) * DETAIL[qualityOf(options)]));
}

function tag<T extends THREE.Object3D>(object: T, name: string, role: string): T {
  object.name = name;
  object.userData.visualOnly = true;
  object.userData.assetRole = role;
  return object;
}

function standard(
  color: number,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0,
    ...options,
  });
}

function glow(color: number, opacity = 0.6): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

function softGlow(color: number, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(color) },
      glowOpacity: { value: opacity },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float glowOpacity;
      varying vec2 vUv;
      void main() {
        float radius = length((vUv - 0.5) * 2.0);
        float alpha = (1.0 - smoothstep(0.08, 1.0, radius)) * glowOpacity;
        gl_FragColor = vec4(glowColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function addGroundGlow(group: THREE.Group, color: number, radius: number, opacity = 0.16): void {
  const pool = tag(new THREE.Mesh(new THREE.CircleGeometry(radius, 36), softGlow(color, opacity)), "life-pool", "soft-ground-light");
  pool.position.set(0, -1.5, -0.95);
  group.add(pool);
}

function createPointField(
  seed: number,
  count: number,
  bounds: readonly [number, number, number],
  palette: readonly number[],
  size: number,
  yOffset = 0,
): THREE.Points {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (random() - 0.5) * bounds[0];
    positions[index * 3 + 1] = (random() - 0.5) * bounds[1] + yOffset;
    positions[index * 3 + 2] = (random() - 0.5) * bounds[2];
    const color = new THREE.Color(palette[Math.floor(random() * palette.length)]);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size,
    vertexColors: true,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  return tag(new THREE.Points(geometry, material), "supporting-particles", "supporting-particles");
}

/** A real, closed-thickness strip: it must catch light as a shell, not read as a line. */
function ribbonGeometry(points: readonly THREE.Vector3[], halfWidth: number, halfThickness = 0.035): THREE.BufferGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const tangent = after.clone().sub(before).normalize();
    const side = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize().multiplyScalar(halfWidth);
    const outer = current.clone().add(side);
    const inner = current.clone().sub(side);
    const frontOffset = new THREE.Vector3(0, 0, halfThickness);
    const backOffset = new THREE.Vector3(0, 0, -halfThickness);
    // Four vertices per sample: outer/inner on the front and back faces.
    vertices.push(
      outer.x + frontOffset.x, outer.y + frontOffset.y, outer.z + frontOffset.z,
      inner.x + frontOffset.x, inner.y + frontOffset.y, inner.z + frontOffset.z,
      outer.x + backOffset.x, outer.y + backOffset.y, outer.z + backOffset.z,
      inner.x + backOffset.x, inner.y + backOffset.y, inner.z + backOffset.z,
    );
    if (index > 0) {
      const previous = (index - 1) * 4;
      const currentIndex = index * 4;
      const po = previous;
      const pi = previous + 1;
      const pbo = previous + 2;
      const pbi = previous + 3;
      const co = currentIndex;
      const ci = currentIndex + 1;
      const cbo = currentIndex + 2;
      const cbi = currentIndex + 3;
      // Front/back faces, then outer and inner walls.
      indices.push(po, co, pi, pi, co, ci, pbo, pbi, cbo, pbi, cbi, cbo, po, pbo, co, pbo, cbo, co, pi, ci, pbi, pbi, ci, cbi);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeCoral(seed: number, count: number): THREE.Group {
  const group = tag(new THREE.Group(), "coral-garden", "living-coral");
  const random = mulberry32(seed);
  const colors = [0xef806e, 0xc2609b, 0xe3ad53, 0x4abca5];
  for (let index = 0; index < count; index += 1) {
    const root = new THREE.Vector3((random() - 0.5) * 6.2, -1.8 + random() * 0.55, -0.45 - random() * 0.4);
    const height = 0.34 + random() * 0.48;
    const branch = new THREE.CatmullRomCurve3([
      root,
      root.clone().add(new THREE.Vector3((random() - 0.5) * 0.13, height * 0.44, 0.02)),
      root.clone().add(new THREE.Vector3((random() - 0.5) * 0.27, height, 0.04)),
    ]);
    const stem = tag(
      new THREE.Mesh(
        new THREE.TubeGeometry(branch, 7, 0.035 + random() * 0.03, 5, false),
        standard(colors[index % colors.length], { emissive: colors[index % colors.length], emissiveIntensity: 0.18, roughness: 0.48 }),
      ),
      `coral-${index}`,
      "coral-branch",
    );
    group.add(stem);
    if (index % 3 === 0) {
      for (const side of [-1, 1]) {
        const forkStart = root.clone().add(new THREE.Vector3(0, height * 0.48, 0.03));
        const fork = new THREE.CatmullRomCurve3([
          forkStart,
          forkStart.clone().add(new THREE.Vector3(side * 0.11, height * 0.15, 0.015)),
          forkStart.clone().add(new THREE.Vector3(side * (0.19 + random() * 0.08), height * 0.32, 0.025)),
        ]);
        group.add(tag(
          new THREE.Mesh(
            new THREE.TubeGeometry(fork, 5, 0.024 + random() * 0.012, 5, false),
            standard(colors[index % colors.length], { emissive: colors[index % colors.length], emissiveIntensity: 0.14, roughness: 0.52 }),
          ),
          `coral-${index}-fork-${side > 0 ? "r" : "l"}`,
          "coral-branch",
        ));
      }
    }
    if (index % 2 === 0) {
      const crown = tag(
        new THREE.Mesh(new THREE.IcosahedronGeometry(0.075 + random() * 0.07, 1), standard(colors[(index + 1) % colors.length], { emissive: 0x4ac6c8, emissiveIntensity: 0.1 })),
        `coral-polyp-${index}`,
        "coral-polyp",
      );
      crown.position.copy(root).add(new THREE.Vector3((random() - 0.5) * 0.22, height, 0.05));
      group.add(crown);
    }
  }
  group.userData.lifeReactive = true;
  return group;
}

function makeKelp(seed: number, count: number): THREE.Group {
  const group = tag(new THREE.Group(), "kelp-forest", "living-kelp");
  const random = mulberry32(seed);
  for (let index = 0; index < count; index += 1) {
    const x = (random() - 0.5) * 6;
    const y = -1.9 + random() * 0.35;
    const height = 0.6 + random() * 0.9;
    const stalk = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, y, -0.75),
      new THREE.Vector3(x + (random() - 0.5) * 0.25, y + height * 0.35, -0.74),
      new THREE.Vector3(x + (random() - 0.5) * 0.48, y + height, -0.72),
    ]);
    const mesh = tag(
      new THREE.Mesh(new THREE.TubeGeometry(stalk, 10, 0.027 + random() * 0.016, 5, false), standard(index % 3 === 0 ? 0x74b743 : 0x278d58, { roughness: 0.7 })),
      `kelp-${index}`,
      "kelp-stalk",
    );
    group.add(mesh);
  }
  group.userData.lifeReactive = true;
  return group;
}

function makeRocks(seed: number, count: number, bounds: readonly [number, number]): THREE.Group {
  const group = tag(new THREE.Group(), "wet-rocks", "natural-rocks");
  const random = mulberry32(seed);
  for (let index = 0; index < count; index += 1) {
    const rock = tag(
      new THREE.Mesh(new THREE.DodecahedronGeometry(0.13 + random() * 0.26, 1), standard(index % 3 === 0 ? 0x315a62 : 0x466b66, { roughness: 0.86 })),
      `rock-${index}`,
      "natural-rock",
    );
    rock.position.set((random() - 0.5) * bounds[0], -1.85 + random() * 0.4, -0.55 - random() * bounds[1]);
    rock.scale.y = 0.55 + random() * 0.35;
    rock.rotation.set(random() * 2, random() * 2, random() * 2);
    group.add(rock);
  }
  return group;
}

function makeFish(seed: number, count: number): THREE.Group {
  const group = tag(new THREE.Group(), "fish-school", "living-fish");
  const random = mulberry32(seed);
  for (let index = 0; index < count; index += 1) {
    const fish = tag(new THREE.Group(), `fish-${index}`, "fish");
    const color = [0xf4b64f, 0x65d9d4, 0xe782a8][index % 3];
    const body = tag(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), standard(color, { emissive: color, emissiveIntensity: 0.12, roughness: 0.42 })), "body", "fish-body");
    body.scale.set(1.5, 0.72, 0.7);
    const tail = tag(new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.17, 3), standard(color, { side: THREE.DoubleSide })), "tail", "fish-tail");
    tail.position.x = -0.14;
    tail.rotation.z = -Math.PI / 2;
    fish.add(body, tail);
    fish.position.set((random() - 0.5) * 5.4, -0.45 + random() * 2.55, -0.65 - random() * 0.55);
    fish.rotation.z = (random() - 0.5) * 0.3;
    fish.scale.setScalar(0.72 + random() * 0.85);
    group.add(fish);
  }
  group.userData.lifeReactive = true;
  return group;
}

/** Luminous, faceless player form: envelope, two swept fins, short water tail, and nested core. */
export function createLuminousDropletHero(options: VisualAssetOptions): THREE.Group {
  const group = tag(new THREE.Group(), "luminous-droplet-hero", "hero");
  group.userData.seed = options.seed >>> 0;
  group.userData.faceSafe = true;
  group.userData.nucleusToBodyRadius = 0.19;
  // A lathed asymmetric tear carries the silhouette.  It deliberately avoids
  // the circular mascot read caused by a bright, centered sphere.
  const teardropProfile = [
    new THREE.Vector2(0, -0.43),
    new THREE.Vector2(0.17, -0.33),
    new THREE.Vector2(0.3, -0.11),
    new THREE.Vector2(0.29, 0.1),
    new THREE.Vector2(0.19, 0.29),
    new THREE.Vector2(0.075, 0.43),
    new THREE.Vector2(0, 0.51),
  ];
  const envelope = tag(
    new THREE.Mesh(
      new THREE.LatheGeometry(teardropProfile, 24),
      new THREE.MeshPhysicalMaterial({ color: 0xb9f6ef, transparent: true, opacity: 0.5, roughness: 0.16, metalness: 0, thickness: 0.32, side: THREE.DoubleSide }),
    ),
    "droplet-envelope",
    "translucent-envelope",
  );
  envelope.scale.set(0.98, 1, 0.76);
  const rim = tag(new THREE.Mesh(new THREE.LatheGeometry(teardropProfile.map((point) => new THREE.Vector2(point.x + 0.018, point.y)), 20), glow(0x9dfcf0, 0.13)), "droplet-rim", "cyan-white-rim");
  rim.scale.set(1.025, 1.01, 0.8);
  rim.rotation.z = -0.045;
  const nucleus = tag(new THREE.Mesh(new THREE.SphereGeometry(0.058, 14, 10), standard(0xeafffb, { emissive: 0xbefef2, emissiveIntensity: 0.96, roughness: 0.18 })), "droplet-nucleus", "small-recessed-white-cyan-nucleus");
  nucleus.position.set(-0.045, -0.035, -0.09);
  const warm = tag(new THREE.Mesh(new THREE.SphereGeometry(0.021, 10, 7), standard(0xffd28a, { emissive: 0xff9e59, emissiveIntensity: 0.72, roughness: 0.3 })), "droplet-warm-core", "tiny-off-axis-warm-accent");
  warm.position.set(0.035, -0.09, -0.12);

  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.quadraticCurveTo(-0.28, 0.06, -0.46, 0.3);
  finShape.quadraticCurveTo(-0.22, 0.38, 0.03, 0.15);
  finShape.quadraticCurveTo(0.08, 0.06, 0, 0);
  const finGeometry = new THREE.ExtrudeGeometry(finShape, { depth: 0.026, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008, bevelSegments: 1, curveSegments: 10 });
  const finMaterial = new THREE.MeshPhysicalMaterial({ color: 0x9eece0, transparent: true, opacity: 0.55, roughness: 0.26, side: THREE.DoubleSide });
  const left = tag(new THREE.Mesh(finGeometry, finMaterial), "wing-left", "swept-membrane-fin");
  const right = tag(new THREE.Mesh(finGeometry.clone(), finMaterial.clone()), "wing-right", "swept-membrane-fin");
  left.position.set(-0.19, -0.06, -0.08);
  left.rotation.set(0.18, 0.43, -0.35);
  left.scale.set(1.08, 0.88, 1);
  right.position.set(0.18, 0.04, -0.12);
  right.rotation.set(0.1, -0.34, Math.PI + 0.47);
  right.scale.set(0.74, 1.16, 0.9);
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.01, -0.34, -0.02),
    new THREE.Vector3(0.11, -0.54, -0.09),
    new THREE.Vector3(-0.09, -0.72, -0.12),
    new THREE.Vector3(-0.02, -0.83, -0.14),
  ]);
  const tail = tag(new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 14, 0.064, 7, false), new THREE.MeshPhysicalMaterial({ color: 0x9ff3eb, transparent: true, opacity: 0.52, roughness: 0.22 })), "water-tail", "attached-water-tail-mobile-readable");
  group.add(left, right, tail, envelope, rim, nucleus, warm);
  return group;
}

/** Dense but bounded coral reef foreground; individual children are named for pulse-only visual response. */
export function createLifeBiome(options: VisualAssetOptions): THREE.Group {
  const group = tag(new THREE.Group(), "life-biome", "life-biome");
  const seed = options.seed >>> 0;
  const background = tag(new THREE.Group(), "reef-background", "reef-background-layer");
  background.position.z = -1.7;
  background.scale.set(1.12, 0.85, 1);
  background.add(
    makeKelp(mixSeed(seed, 0x1a10), countFor(options, 5, 14)),
    makeCoral(mixSeed(seed, 0x1a11), countFor(options, 5, 15)),
  );
  const midground = tag(new THREE.Group(), "reef-midground", "reef-midground-layer");
  midground.position.z = -0.95;
  midground.add(
    makeRocks(mixSeed(seed, 0x1a12), countFor(options, 5, 12), [6.8, 0.45]),
    makeKelp(mixSeed(seed, 0x1a13), countFor(options, 4, 11)),
    makeFish(mixSeed(seed, 0x1a14), countFor(options, 5, 14)),
  );
  const foreground = tag(new THREE.Group(), "reef-foreground", "reef-foreground-occlusion-layer");
  foreground.position.z = -0.12;
  foreground.add(
    makeRocks(mixSeed(seed, 0x1a15), countFor(options, 4, 10), [6.8, 0.18]),
    makeCoral(mixSeed(seed, 0x1a16), countFor(options, 5, 14)),
  );
  const beams = tag(new THREE.Group(), "water-light-rays", "water-light-rays");
  for (let index = 0; index < 4; index += 1) {
    const beam = tag(
      new THREE.Mesh(
        new THREE.ConeGeometry(0.48 + index * 0.08, 4.8, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x6acde8, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      ),
      `water-ray-${index}`,
      "water-light-ray",
    );
    beam.position.set(-2.4 + index * 1.55, 0.45, -1.25 - index * 0.04);
    beam.rotation.z = -0.12 + index * 0.07;
    beams.add(beam);
  }
  group.add(
    beams,
    background,
    midground,
    foreground,
    createPointField(mixSeed(seed, 0x1a4), countFor(options, 70, 220), [6.8, 4.8, 1.4], [0xb4f7f4, 0x54cde4], 0.026, 0.35),
  );
  addGroundGlow(group, 0x1f9fc2, 3.9, 0.18);
  group.userData.lifeReactive = true;
  return group;
}

function createTree(index: number, random: () => number): THREE.Group {
  const tree = tag(new THREE.Group(), `tree-${index}`, "forest-tree");
  const height = 0.42 + random() * 0.58;
  const trunk = tag(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, height, 6), standard(0x665344, { roughness: 0.9 })), "trunk", "tree-trunk");
  trunk.position.y = height * 0.5;
  const crown = tag(new THREE.Mesh(new THREE.IcosahedronGeometry(0.2 + random() * 0.15, 1), standard(random() > 0.4 ? 0x2f854b : 0x5ea944, { roughness: 0.76 })), "crown", "tree-crown");
  crown.position.set((random() - 0.5) * 0.09, height + 0.11, 0);
  crown.scale.set(0.95, 1.25, 0.9);
  tree.add(trunk, crown);
  return tree;
}

/** Forest, river, waterfall and cloud silhouettes for the bright EARTH and ASCENT reference panels. */
export function createEarthNature(options: VisualAssetOptions): THREE.Group {
  const group = tag(new THREE.Group(), "earth-nature", "earth-nature-biome");
  const random = mulberry32(mixSeed(options.seed, 0x2b0));
  const river = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.8, -2.05, -0.55),
    new THREE.Vector3(-1.35, -1.18, -0.62),
    new THREE.Vector3(-0.55, -0.26, -0.65),
    new THREE.Vector3(0.42, 0.12, -0.68),
    new THREE.Vector3(1.55, 1.02, -0.72),
    new THREE.Vector3(2.5, 1.85, -0.74),
  ]);
  const riverPoints = river.getPoints(48);
  const riverSurface = tag(
    new THREE.Mesh(
      ribbonGeometry(riverPoints, 0.3, 0.025),
      new THREE.MeshPhysicalMaterial({ color: 0x36bfd2, emissive: 0x0e6078, emissiveIntensity: 0.18, transparent: true, opacity: 0.78, roughness: 0.28, side: THREE.DoubleSide }),
    ),
    "living-river",
    "river",
  );
  const riverFoam = tag(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(riverPoints),
      new THREE.LineBasicMaterial({ color: 0xbfefff, transparent: true, opacity: 0.58, depthWrite: false }),
    ),
    "river-foam",
    "water-foam",
  );
  riverFoam.position.z = 0.025;
  group.add(riverSurface, riverFoam);
  const forest = tag(new THREE.Group(), "forest", "living-forest");
  const canopyBack = tag(new THREE.Group(), "canopy-background", "canopy-background-layer");
  canopyBack.position.z = -1.55;
  canopyBack.scale.set(1.1, 0.85, 1);
  const canopyMid = tag(new THREE.Group(), "canopy-midground", "canopy-midground-layer");
  canopyMid.position.z = -0.95;
  const canopyFront = tag(new THREE.Group(), "canopy-foreground", "canopy-foreground-layer");
  canopyFront.position.z = -0.28;
  const treeCount = countFor(options, 14, 44);
  for (let index = 0; index < treeCount; index += 1) {
    const tree = createTree(index, random);
    tree.position.set((random() - 0.5) * 6.2, -1.92 + random() * 1.8, -0.62 - random() * 0.52);
    tree.scale.setScalar(0.72 + random() * 0.72);
    (index % 3 === 0 ? canopyBack : index % 3 === 1 ? canopyMid : canopyFront).add(tree);
  }
  forest.add(canopyBack, canopyMid, canopyFront);
  forest.userData.lifeReactive = true;
  const rockBank = tag(makeRocks(mixSeed(options.seed, 0x2b1), countFor(options, 7, 18), [6.5, 0.65]), "river-rock-banks", "river-rock-banks");
  group.add(forest, rockBank);
  const waterfall = tag(new THREE.Group(), "waterfall", "waterfall");
  for (let index = 0; index < 3; index += 1) {
    const x = 1.38 + index * 0.24;
    const fallPoints = [
      new THREE.Vector3(x, 1.62 - index * 0.05, -0.42 - index * 0.025),
      new THREE.Vector3(x + 0.05, 1.12, -0.4 - index * 0.025),
      new THREE.Vector3(x - 0.04, 0.55, -0.38 - index * 0.025),
      new THREE.Vector3(x + 0.08, -0.05, -0.35 - index * 0.025),
    ];
    const curtain = tag(
      new THREE.Mesh(
        ribbonGeometry(fallPoints, 0.13 - index * 0.018),
        new THREE.MeshBasicMaterial({ color: index === 1 ? 0xe8fbff : 0x72d8ea, transparent: true, opacity: index === 1 ? 0.56 : 0.46, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      ),
      `waterfall-stream-${index}`,
      "waterfall-stream",
    );
    waterfall.add(curtain);
  }
  const mist = tag(new THREE.Group(), "waterfall-mist", "waterfall-mist");
  for (let index = 0; index < 5; index += 1) {
    const puff = tag(new THREE.Mesh(new THREE.SphereGeometry(0.16 + index * 0.025, 10, 7), standard(0xdff8f1, { transparent: true, opacity: 0.28, roughness: 1 })), `mist-${index}`, "mist-volume");
    puff.position.set(1.1 + index * 0.25, -0.12 + (index % 2) * 0.08, -0.32);
    puff.scale.set(1.6, 0.55, 0.8);
    mist.add(puff);
  }
  waterfall.add(mist);
  waterfall.userData.volume = true;
  group.add(waterfall);
  addGroundGlow(group, 0x67d8bd, 3.4, 0.13);
  return group;
}

/** Soft, large cloud volumes. Keep the returned group separate so world code can animate it at low frequency. */
export function createCloudBank(options: VisualAssetOptions): THREE.Group {
  const group = tag(new THREE.Group(), "cloud-bank", "cloud-bank");
  const random = mulberry32(mixSeed(options.seed, 0x3c0));
  const depthLayers = [
    { name: "cloud-far", z: -3.25, opacity: 0.34, scale: 0.74, count: countFor(options, 2, 6) },
    { name: "cloud-mid", z: -2.05, opacity: 0.54, scale: 1, count: countFor(options, 3, 8) },
    { name: "cloud-near", z: -0.9, opacity: 0.72, scale: 1.28, count: countFor(options, 2, 5) },
  ];
  let index = 0;
  for (const layer of depthLayers) {
    const layerGroup = tag(new THREE.Group(), layer.name, `${layer.name}-layer`);
    for (let local = 0; local < layer.count; local += 1) {
      const cloud = tag(new THREE.Mesh(new THREE.SphereGeometry(0.28 + random() * 0.28, 12, 9), standard(index % 4 === 0 ? 0xc2d8ff : 0xe3f2ee, { transparent: true, opacity: layer.opacity, roughness: 0.92 })), `cloud-${index}`, "cloud-volume");
      cloud.position.set((random() - 0.5) * 7.3, -0.65 + random() * 3.55, layer.z - random() * 0.42);
      cloud.scale.set(layer.scale * (1.4 + random()), layer.scale * (0.5 + random() * 0.34), layer.scale * (0.76 + random() * 0.32));
      layerGroup.add(cloud);
      index += 1;
    }
    group.add(layerGroup);
  }
  return group;
}

/** Small living Earth with terrain blobs and an atmosphere, intentionally not a textured photoreal globe. */
export function createLivingEarth(options: VisualAssetOptions): THREE.Group {
  const group = tag(new THREE.Group(), "living-earth", "living-earth");
  const ocean = tag(new THREE.Mesh(new THREE.SphereGeometry(0.78, 24, 18), standard(0x206f9d, { roughness: 0.34, metalness: 0.04, emissive: 0x0b3d6d, emissiveIntensity: 0.17 })), "earth-ocean", "earth-ocean");
  const land = tag(new THREE.Group(), "earth-land", "earth-land");
  const random = mulberry32(mixSeed(options.seed, 0x4d0));
  for (let index = 0; index < countFor(options, 5, 10); index += 1) {
    const latitude = (random() - 0.5) * 1.8;
    const longitude = random() * Math.PI * 2;
    const radius = Math.cos(latitude);
    const normal = new THREE.Vector3(
      Math.cos(longitude) * radius,
      Math.sin(latitude),
      Math.sin(longitude) * radius,
    ).normalize();
    const patch = tag(new THREE.Mesh(new THREE.IcosahedronGeometry(0.11 + random() * 0.08, 1), standard(index % 3 === 0 ? 0x7aae4d : 0x398a5d, { roughness: 0.84 })), `land-${index}`, "earth-land-patch");
    patch.position.copy(normal).multiplyScalar(0.785);
    patch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    patch.scale.set(1.35, 0.82, 0.18);
    land.add(patch);
  }
  const atmosphere = tag(new THREE.Mesh(new THREE.SphereGeometry(0.835, 24, 18), glow(0x8be5ff, 0.16)), "earth-atmosphere", "earth-atmosphere");
  group.add(ocean, land, atmosphere);
  return group;
}

/** Broad, layered nebula planes plus stars. Their slow transforms are presentation-only. */
export function createNebulaGalaxy(options: VisualAssetOptions): THREE.Group {
  const group = tag(new THREE.Group(), "nebula-galaxy", "nebula-galaxy");
  const random = mulberry32(mixSeed(options.seed, 0x5e0));
  const layers = [0x2b55a1, 0x6f4ea7, 0xbd5e9d, 0x4ac6bc];
  for (let index = 0; index < 4; index += 1) {
    const nebula = tag(new THREE.Mesh(new THREE.CircleGeometry(1.4 + index * 0.38, 36), softGlow(layers[index], 0.21 + index * 0.018)), `nebula-${index}`, "broad-nebula-layer");
    nebula.position.set((index - 1.5) * 0.8, (random() - 0.5) * 1.5, -2.3 - index * 0.16);
    nebula.scale.set(1.7, 0.46 + index * 0.08, 1);
    nebula.rotation.z = -0.62 + index * 0.42;
    group.add(nebula);
  }
  group.add(createPointField(mixSeed(options.seed, 0x5e1), countFor(options, 100, 340), [10.5, 6.7, 4], [0xb9d8ff, 0xe49bd0, 0x8edcf5], 0.038));
  return group;
}

/** Three open, broad ribbon shells around an unfilled central void; never use this as a thin atom icon. */
export function createUnknownRibbonShip(options: VisualAssetOptions): THREE.Group {
  const group = tag(new THREE.Group(), "unknown-ribbon-ship", "unknown-three-shell-ship");
  group.userData.seed = options.seed >>> 0;
  group.userData.centralVoid = true;
  const baseColors = [0x183b46, 0x35243f, 0x493128];
  const glowColors = [0x55d5d1, 0xd47faf, 0xf2a466];
  for (let shell = 0; shell < 3; shell += 1) {
    const start = -1.25 + shell * 0.09;
    const points: THREE.Vector3[] = [];
    for (let step = 0; step < 22; step += 1) {
      const t = start + (step / 21) * 2.08;
      const radius = 1.12 + Math.sin(t * 2 + shell * 1.8) * 0.11;
      points.push(new THREE.Vector3(
        Math.cos(t + shell * ((Math.PI * 2) / 3)) * radius,
        Math.sin(t + shell * ((Math.PI * 2) / 3)) * radius * 0.64,
        -0.08 + Math.sin(t * 1.4 + shell) * 0.24,
      ));
    }
    const ribbon = tag(
      new THREE.Mesh(ribbonGeometry(points, 0.14, 0.052), new THREE.MeshPhysicalMaterial({ color: baseColors[shell], emissive: glowColors[shell], emissiveIntensity: 0.22, transparent: true, opacity: 0.86, roughness: 0.31, metalness: 0.16, iridescence: 0.46, iridescenceIOR: 1.34, side: THREE.DoubleSide, depthWrite: true })),
      `ribbon-shell-${shell + 1}`,
      "broad-curved-ribbon-shell",
    );
    ribbon.userData.shellThickness = 0.104;
    ribbon.userData.shellIndex = shell + 1;
    const flowPoints = points.map((point) => point.clone().add(new THREE.Vector3(0, 0, 0.057)));
    const internalFlow = tag(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(flowPoints),
        new THREE.LineBasicMaterial({ color: glowColors[shell], transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }),
      ),
      `ribbon-flow-${shell + 1}`,
      "restrained-internal-color-flow",
    );
    ribbon.add(internalFlow);
    group.add(ribbon);
  }
  const voidDisk = tag(
    new THREE.Mesh(
      new THREE.CircleGeometry(0.43, 40),
      new THREE.MeshBasicMaterial({ color: 0x02050d, transparent: true, opacity: 0.94, depthWrite: false }),
    ),
    "central-void",
    "central-void",
  );
  voidDisk.position.z = -0.18;
  const innerGlow = tag(new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.025, 8, 36), glow(0xc7f3ed, 0.2)), "void-rim", "central-void-rim");
  innerGlow.rotation.x = 0.15;
  group.add(voidDisk, innerGlow);
  return group;
}

/** Final-stage supporting lights that radiate around a small Earth without changing play state. */
export function createLifeWaveAccents(options: VisualAssetOptions): THREE.Group {
  const group = tag(new THREE.Group(), "life-wave-accents", "final-life-waves");
  const random = mulberry32(mixSeed(options.seed, 0x6f0));
  for (let index = 0; index < countFor(options, 4, 8); index += 1) {
    const curve = new THREE.EllipseCurve(0, 0, 0.45 + index * 0.12, 0.2 + index * 0.05, 0.25, Math.PI * 1.28, false, index * 0.4);
    const points = curve.getSpacedPoints(48).map((point) => new THREE.Vector3(point.x, point.y, -0.8 - random() * 0.5));
    const accent = tag(
      new THREE.Points(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.PointsMaterial({ color: [0xffd77a, 0x7ce3cf, 0xa8bfff][index % 3], size: 0.034, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
      ),
      `life-wave-${index}`,
      "life-wave",
    );
    accent.userData.maxCount = points.length;
    accent.position.set((random() - 0.5) * 5, -0.82 + random() * 1.36, 0);
    group.add(accent);
  }
  return group;
}

/** Warm-neutral key/fill/rim rig for physical materials. Attach once to the scene, not per biome. */
export function createNaturalLighting(): VisualLighting {
  const group = tag(new THREE.Group(), "natural-lighting", "scene-lighting");
  const hemi = new THREE.HemisphereLight(0xc8ecff, 0x213835, 1.45);
  hemi.name = "sky-water-hemisphere";
  const key = new THREE.DirectionalLight(0xfff1cf, 1.7);
  key.name = "warm-key";
  key.position.set(-3.2, 4.2, 4.8);
  const cyanRim = new THREE.PointLight(0x5fd7e8, 9, 8, 2);
  cyanRim.name = "cyan-rim";
  cyanRim.position.set(2.7, 0.8, 2.6);
  const coralBounce = new THREE.PointLight(0xff9572, 5.5, 6, 2);
  coralBounce.name = "coral-bounce";
  coralBounce.position.set(-2.8, -1.3, 1.4);
  group.add(hemi, key, cyanRim, coralBounce);
  return { group, key: "natural-lighting" };
}

/** Dispose a caller-owned visual asset tree. It does not dispose the renderer or scene. */
export function disposeVisualAsset(object: THREE.Object3D): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  object.traverse((item) => {
    const mesh = item as THREE.Mesh;
    if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((entry) => {
      if (!disposedMaterials.has(entry)) {
        disposedMaterials.add(entry);
        entry.dispose();
      }
    });
  });
}
