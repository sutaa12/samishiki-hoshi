import * as THREE from "three";
import { mixSeed, mulberry32 } from "./procedural";
import type { JourneyPhase, QualityLevel, Vec2 } from "./model";
import {
  createCloudBank,
  createEarthNature,
  createLifeBiome,
  createLifeWaveAccents,
  createLivingEarth,
  createLuminousDropletHero,
  createNaturalLighting,
  createNebulaGalaxy,
  createUnknownRibbonShip,
} from "./visual-assets";

export interface AccessibilityRenderOptions {
  reducedMotion?: boolean;
  highContrast?: boolean;
  /** Deliberately visual only: simulation owns the actual assistance. */
  wideFlow?: boolean;
  colorIndependentCues?: boolean;
}

export interface WorldOptions {
  canvas: HTMLCanvasElement;
  seed: number;
  quality?: QualityLevel;
  accessibility?: AccessibilityRenderOptions;
}

export interface WorldFrame {
  storyTime: number;
  phase: JourneyPhase;
  shot?: string | { id: string };
  position: Vec2;
  pulseCount: number;
  answerAt: number | null;
  finished: boolean;
}

export interface WorldMetrics {
  frameMs: number;
  fps: number;
  drawCalls: number;
  triangles: number;
  quality: QualityLevel;
  webgl: true;
}

type Palette = readonly [number, number, number][];

const QUALITY_SCALE: Record<QualityLevel, number> = { low: 0.38, balanced: 0.68, high: 1 };
const PHASE_COLOUR: Record<JourneyPhase, number> = {
  LIFE: 0x061b35,
  EARTH: 0x17371d,
  ASCENT: 0x16264c,
  SOLITUDE: 0x050713,
  ANSWER: 0x100c2e,
  TWINKLE: 0x111b39,
};

function disposeObject(object: THREE.Object3D): void {
  object.traverse((item) => {
    const mesh = item as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
  });
}

function material(color: number, opacity = 1, blending: THREE.Blending = THREE.NormalBlending): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1 || blending !== THREE.NormalBlending, opacity, blending, depthWrite: blending === THREE.NormalBlending });
}

function pointCloud(seed: number, count: number, palette: Palette, box: readonly [number, number, number], size: number, yBias = 0): THREE.Points {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (random() - 0.5) * box[0];
    positions[i * 3 + 1] = (random() - 0.5) * box[1] + yBias;
    positions[i * 3 + 2] = (random() - 0.5) * box[2];
    const swatch = palette[Math.floor(random() * palette.length)];
    colors[i * 3] = swatch[0];
    colors[i * 3 + 1] = swatch[1];
    colors[i * 3 + 2] = swatch[2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const cloud = new THREE.Points(geometry, new THREE.PointsMaterial({ size, vertexColors: true, transparent: true, opacity: 0.86, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
  cloud.userData.maxCount = count;
  return cloud;
}

function rectilinearFrame(width: number, height: number, depth: number, colour: number, opacity = 0.7): THREE.Group {
  const group = new THREE.Group();
  const beam = new THREE.BoxGeometry(1, 1, 1);
  const mat = material(colour, opacity);
  const add = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    const part = new THREE.Mesh(beam, mat);
    part.position.set(x, y, z);
    part.scale.set(sx, sy, sz);
    group.add(part);
  };
  add(-width / 2, 0, 0, 0.08, height, depth);
  add(width / 2, 0, 0, 0.08, height, depth);
  add(0, height / 2, 0, width, 0.08, depth);
  add(0, -height / 2, 0, width, 0.08, depth);
  return group;
}

/**
 * Renderer-only presentation of the deterministic journey. It never receives
 * inputs or mutates the simulation, so density/quality cannot change hashes.
 */
export class LonelyStarWorld {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  private readonly referenceLighting = createNaturalLighting().group;
  private readonly groups: Record<JourneyPhase, THREE.Group>;
  private readonly unknownSilhouette: THREE.Group;
  private readonly human: THREE.Group;
  private readonly player = new THREE.Group();
  private readonly pulses = new THREE.Group();
  private readonly dynamicClouds: THREE.Points[] = [];
  private readonly pulseRings: { born: number; object: THREE.Object3D }[] = [];
  private options: Required<Pick<WorldOptions, "seed" | "quality">> & { accessibility: AccessibilityRenderOptions };
  private lastFrame = 16.67;
  private lastRealTime: number | null = null;
  private lastPulseCount = 0;
  private destroyed = false;
  private readonly contextLost = (event: Event): void => {
    event.preventDefault();
    this.destroyed = true;
  };

  public constructor(options: WorldOptions) {
    this.options = { seed: options.seed >>> 0, quality: options.quality ?? "balanced", accessibility: { ...options.accessibility } };
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: options.canvas, antialias: this.options.quality === "high", alpha: false, powerPreference: "high-performance" });
    } catch (error) {
      throw new Error(`WebGL を開始できませんでした: ${error instanceof Error ? error.message : "unknown renderer error"}`);
    }
    options.canvas.addEventListener("webglcontextlost", this.contextLost, false);
    this.renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio || 1,
        this.options.quality === "high" ? 1.5 : this.options.quality === "balanced" ? 1.25 : 1,
      ),
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera.position.set(0, 0.1, 6.8);
    this.scene.add(this.referenceLighting);
    this.scene.fog = new THREE.FogExp2(PHASE_COLOUR.LIFE, 0.075);
    this.scene.background = new THREE.Color(PHASE_COLOUR.LIFE);

    this.groups = {
      LIFE: this.buildLife(),
      EARTH: this.buildEarth(),
      ASCENT: this.buildAscent(),
      SOLITUDE: this.buildSolitude(),
      ANSWER: this.buildAnswer(),
      TWINKLE: this.buildTwinkle(),
    };
    Object.values(this.groups).forEach((group) => this.scene.add(group));
    this.unknownSilhouette = this.buildUnknownSilhouette();
    this.human = new THREE.Group();
    this.buildHumanGrammar(this.human);
    this.scene.add(this.unknownSilhouette, this.human, this.player, this.pulses);
    this.buildPlayer();
    this.applyQuality();
    this.resize();
  }

  public resize(width = this.renderer.domElement.clientWidth, height = this.renderer.domElement.clientHeight): void {
    if (this.destroyed) return;
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    this.camera.aspect = safeWidth / safeHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(safeWidth, safeHeight, false);
  }

  public setOptions(options: Partial<Omit<WorldOptions, "canvas" | "seed">>): void {
    if (options.quality && options.quality !== this.options.quality) {
      this.options.quality = options.quality;
      this.renderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, options.quality === "high" ? 1.5 : options.quality === "balanced" ? 1.25 : 1),
      );
      this.applyQuality();
      this.resize();
    }
    if (options.accessibility) this.options.accessibility = { ...this.options.accessibility, ...options.accessibility };
  }

  public emitPulse(position: Vec2): void {
    if (this.destroyed) return;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.105, 36), material(0xc8fff2, 0.9, THREE.AdditiveBlending));
    ring.position.set(position.x * 2.7, position.y * 1.8, 0.28);
    this.pulses.add(ring);
    this.pulseRings.push({ born: performance.now() / 1000, object: ring });
  }

  public update(frame: WorldFrame, realTime = performance.now() / 1000): void {
    if (this.destroyed) return;
    const elapsed = realTime;
    this.lastFrame = this.lastRealTime === null ? 16.67 : Math.max(0.01, Math.min(1000, (realTime - this.lastRealTime) * 1000));
    this.lastRealTime = realTime;
    const phaseTime = Math.max(0, Math.min(1, (frame.storyTime % 36) / 36));
    const reduced = Boolean(this.options.accessibility.reducedMotion);
    const motion = reduced ? 0 : realTime;
    let background = PHASE_COLOUR[frame.phase];
    if (frame.phase === "LIFE") background = frame.storyTime < 18 ? 0x063052 : 0x082844;
    if (frame.phase === "EARTH") background = frame.storyTime < 62 ? 0x173f32 : 0x5a3433;
    if (frame.phase === "ASCENT") background = frame.storyTime < 112 ? 0x284466 : 0x17294e;
    this.scene.background = new THREE.Color(background);
    (this.scene.fog as THREE.FogExp2).color.setHex(background);
    (this.scene.fog as THREE.FogExp2).density = frame.phase === "SOLITUDE" || frame.phase === "ANSWER" ? 0.022 : 0.07;
    (Object.keys(this.groups) as JourneyPhase[]).forEach((phase) => {
      this.groups[phase].visible = phase === frame.phase;
    });
    // After the 161-second reveal, the three-shell craft remains beside the
    // player through TWINKLE, as shown by the authoritative final gameplay art.
    this.groups.ANSWER.visible = frame.storyTime >= 161;
    // S20 is only a peripheral, incomplete hint. The complete three-shell ship
    // and its central void are reserved for ANSWER at 161 seconds.
    this.unknownSilhouette.visible = frame.storyTime >= 155 && frame.storyTime < 161;
    const silhouetteReveal = Math.max(0, Math.min(1, (frame.storyTime - 155) / 6));
    this.unknownSilhouette.children.forEach((child) => {
      const lineMaterial = (child as THREE.Line).material as THREE.LineBasicMaterial;
      lineMaterial.opacity = 0.06 + silhouetteReveal * 0.18;
    });
    // Human-made forms exist only once the authored timeline permits them.
    this.human.visible = frame.storyTime >= 18 && frame.phase !== "ANSWER" && frame.phase !== "TWINKLE";
    this.human.children.forEach((item) => {
      const visibleAt = typeof item.userData.visibleAt === "number" ? item.userData.visibleAt : 0;
      const visibleUntil = typeof item.userData.visibleUntil === "number" ? item.userData.visibleUntil : 180;
      item.visible = this.human.visible && frame.storyTime >= visibleAt && frame.storyTime < visibleUntil;
    });
    this.player.position.set(frame.position.x * 2.7, frame.position.y * 1.8, 0.32);
    this.player.rotation.z = Math.atan2(frame.position.y, frame.position.x) * 0.12;
    const playerViewportScale = this.camera.aspect < 0.72 ? 0.58 : this.camera.aspect < 1 ? 0.78 : 1;
    this.player.scale.setScalar(playerViewportScale * (1 + Math.sin(realTime * 4) * 0.06));
    const wingScale = 0.78 + Math.min(0.22, frame.storyTime / 180 * 0.22);
    const finalWing = frame.storyTime >= 171 ? 1.22 : 1;
    const wingLeft = this.player.getObjectByName("wing-left");
    const wingRight = this.player.getObjectByName("wing-right");
    wingLeft?.scale.set(wingScale * finalWing, wingScale, 1);
    wingRight?.scale.set(wingScale * finalWing, wingScale, 1);

    this.groups.LIFE.rotation.z = motion * 0.008;
    this.groups.EARTH.position.x = Math.sin(motion * 0.22) * 0.025;
    this.groups.ASCENT.position.y = Math.sin(motion * 0.45) * 0.12;
    const ascentEarth = this.groups.ASCENT.getObjectByName("living-earth");
    if (ascentEarth) ascentEarth.rotation.y = motion * 0.035;
    this.groups.SOLITUDE.rotation.y = motion * 0.01;
    this.unknownSilhouette.rotation.z = motion * 0.012;
    this.groups.ANSWER.rotation.z = motion * 0.045;
    this.groups.TWINKLE.rotation.z = motion * 0.004;
    const finalEarth = this.groups.TWINKLE.getObjectByName("living-earth");
    if (finalEarth) finalEarth.rotation.y = motion * 0.028;
    this.dynamicClouds.forEach((cloud, index) => { cloud.rotation.z = motion * (0.008 + index * 0.003); });

    if (frame.pulseCount > this.lastPulseCount) this.emitPulse(frame.position);
    this.lastPulseCount = frame.pulseCount;
    const lifeStrength = Math.min(1, frame.pulseCount / 10);
    this.groups.LIFE.children.forEach((child) => { if (child.userData.lifeReactive) child.scale.setScalar(0.96 + lifeStrength * 0.07); });
    this.groups.EARTH.children.forEach((child) => { if (child.userData.lifeReactive) child.scale.setScalar(0.97 + lifeStrength * 0.05); });

    for (let index = this.pulseRings.length - 1; index >= 0; index -= 1) {
      const pulse = this.pulseRings[index];
      const age = elapsed - pulse.born;
      pulse.object.scale.setScalar(1 + age * 2.6);
      const pulseMaterial = (pulse.object as THREE.Mesh).material as THREE.MeshBasicMaterial;
      pulseMaterial.opacity = Math.max(0, 0.9 - age * 0.75);
      if (age > 1.25) {
        this.pulses.remove(pulse.object);
        disposeObject(pulse.object);
        this.pulseRings.splice(index, 1);
      }
    }

    const response = frame.answerAt === null ? 0 : Math.max(0, Math.min(1, (frame.storyTime - frame.answerAt) / 2.5));
    const portraitScale = this.camera.aspect < 0.72 ? 0.58 : this.camera.aspect < 1 ? 0.78 : 1;
    const isFinale = frame.storyTime >= 171;
    const finaleScale = this.camera.aspect < 0.72 ? 0.56 : this.camera.aspect < 1 ? 0.67 : 0.72;
    this.groups.ANSWER.scale.setScalar(
      (0.9 + response * 0.2 + Math.sin(motion * 1.7) * 0.02) * portraitScale * (isFinale ? finaleScale : 1),
    );
    const portraitFinale = this.camera.aspect < 0.72;
    const companionDirection = this.player.position.x > 0 ? -1 : 1;
    const companionOffset = portraitFinale ? 0.78 : 1.22;
    const companionLimit = portraitFinale ? 0.78 : 2.05;
    const companionX = Math.max(
      -companionLimit,
      Math.min(companionLimit, this.player.position.x + companionDirection * companionOffset),
    );
    const companionY = Math.max(
      portraitFinale ? -1.05 : -1.1,
      Math.min(portraitFinale ? 0.1 : 0.55, this.player.position.y - (portraitFinale ? 0.48 : 0.28)),
    );
    this.groups.ANSWER.position.set(
      isFinale ? companionX : 0,
      isFinale ? companionY : (portraitFinale ? -0.28 : 0),
      isFinale ? -0.3 : 0,
    );
    const answerNebula = this.groups.ANSWER.getObjectByName("nebula-galaxy");
    if (answerNebula) answerNebula.visible = !isFinale;
    this.groups.TWINKLE.traverse((child) => {
      if (child instanceof THREE.Points) {
        const max = child.userData.maxCount as number;
        const reveal = Math.max(0.025, Math.min(1, (frame.storyTime - 171) / 9));
        child.geometry.setDrawRange(0, Math.floor(max * reveal * QUALITY_SCALE[this.options.quality]));
      }
    });
    if (this.options.accessibility.highContrast) this.renderer.toneMappingExposure = 1.35;
    else this.renderer.toneMappingExposure = 1.05 + phaseTime * 0.08;
    this.renderer.render(this.scene, this.camera);
  }

  public get metrics(): WorldMetrics {
    const info = this.renderer.info.render;
    return { frameMs: Number(this.lastFrame.toFixed(2)), fps: Number((1000 / this.lastFrame).toFixed(1)), drawCalls: info.calls, triangles: info.triangles, quality: this.options.quality, webgl: true };
  }

  public dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer.domElement.removeEventListener("webglcontextlost", this.contextLost, false);
    disposeObject(this.scene);
    this.renderer.dispose();
  }

  private applyQuality(): void {
    const density = QUALITY_SCALE[this.options.quality];
    this.dynamicClouds.forEach((cloud) => cloud.geometry.setDrawRange(0, Math.floor((cloud.userData.maxCount as number) * density)));
  }

  private trackVisualAsset<T extends THREE.Object3D>(asset: T): T {
    asset.traverse((child) => {
      if (!(child instanceof THREE.Points)) return;
      child.userData.maxCount ??= child.geometry.getAttribute("position").count;
      if (!this.dynamicClouds.includes(child)) this.dynamicClouds.push(child);
    });
    return asset;
  }

  private buildLife(): THREE.Group {
    const group = new THREE.Group();
    group.name = "life-reference-scene";
    const water = new THREE.Mesh(new THREE.PlaneGeometry(14, 9), material(0x063a62, 0.82));
    water.name = "deep-ocean-field";
    water.position.z = -1.7;
    group.add(water);
    const rays = pointCloud(mixSeed(this.options.seed, 0x11), 210, [[0.28, 0.76, 1], [0.5, 0.92, 0.9]], [7, 5.6, 3], 0.045, 0.4);
    rays.userData.lifeReactive = true;
    const bubbles = pointCloud(mixSeed(this.options.seed, 0x12), 135, [[0.82, 0.98, 1], [0.25, 0.83, 0.95]], [5.2, 4.2, 1.5], 0.032);
    this.dynamicClouds.push(rays, bubbles);
    group.add(rays, bubbles);
    const biome = this.trackVisualAsset(createLifeBiome({ seed: mixSeed(this.options.seed, 0x13), quality: this.options.quality }));
    biome.userData.lifeReactive = true;
    group.add(biome);
    return group;
  }

  private buildEarth(): THREE.Group {
    const group = new THREE.Group();
    group.name = "earth-reference-scene";
    const nature = this.trackVisualAsset(createEarthNature({ seed: mixSeed(this.options.seed, 0x21), quality: this.options.quality }));
    nature.userData.lifeReactive = true;
    group.add(nature);
    const birds = pointCloud(mixSeed(this.options.seed, 0x22), 90, [[1, 0.88, 0.48], [0.85, 1, 0.68]], [5.8, 3.5, 1.6], 0.035, 0.65);
    this.dynamicClouds.push(birds);
    group.add(birds);
    return group;
  }

  private buildAscent(): THREE.Group {
    const group = new THREE.Group();
    group.name = "ascent-reference-scene";
    const clouds = this.trackVisualAsset(createCloudBank({ seed: mixSeed(this.options.seed, 0x31), quality: this.options.quality }));
    group.add(clouds);
    const earth = createLivingEarth({ seed: mixSeed(this.options.seed, 0x32), quality: this.options.quality });
    earth.scale.setScalar(2.08);
    earth.position.set(1.9, -1.68, -2.45);
    group.add(earth);
    const aurora = pointCloud(mixSeed(this.options.seed, 0x33), 180, [[0.2, 1, 0.74], [0.35, 0.45, 1], [0.8, 0.45, 1]], [7, 2.4, 1.8], 0.06, 1.4);
    this.dynamicClouds.push(aurora);
    group.add(aurora);
    return group;
  }

  private buildSolitude(): THREE.Group {
    const group = new THREE.Group();
    group.name = "solitude-reference-scene";
    const nebula = this.trackVisualAsset(createNebulaGalaxy({ seed: mixSeed(this.options.seed, 0x40), quality: this.options.quality }));
    nebula.scale.set(1.18, 1.05, 1);
    group.add(nebula);
    const stars = pointCloud(mixSeed(this.options.seed, 0x41), 360, [[0.72, 0.86, 1], [1, 0.62, 0.82], [0.78, 0.65, 1]], [11, 7, 5], 0.045);
    this.dynamicClouds.push(stars);
    group.add(stars);
    const debris = new THREE.Group();
    const random = mulberry32(mixSeed(this.options.seed, 0x42));
    for (let i = 0; i < 22; i += 1) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.12 + random() * 0.55, 0.035, 0.12 + random() * 0.42), material(i % 3 === 0 ? 0x8197af : 0x394457, 0.72));
      panel.position.set((random() - 0.5) * 6.2, (random() - 0.5) * 4.1, -0.4 - random() * 1.4);
      panel.rotation.set(random() * 1.5, random() * 1.5, random() * 1.5);
      debris.add(panel);
    }
    group.add(debris);
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.45, 0.05), material(0xffad42, 0.96, THREE.AdditiveBlending));
    beacon.position.set(-1.8, 0.15, -0.8);
    group.add(beacon);
    return group;
  }

  private buildAnswer(): THREE.Group {
    const group = new THREE.Group();
    group.name = "answer-reference-scene";
    const backdrop = this.trackVisualAsset(createNebulaGalaxy({ seed: mixSeed(this.options.seed, 0x50), quality: this.options.quality }));
    backdrop.scale.set(1.08, 1.08, 1);
    const ship = createUnknownRibbonShip({ seed: mixSeed(this.options.seed, 0x51), quality: this.options.quality });
    ship.name = "answer-three-shell-craft";
    const dust = pointCloud(mixSeed(this.options.seed, 0x52), 140, [[0.65, 0.86, 1], [1, 0.62, 0.85]], [7, 4.5, 2], 0.035);
    this.dynamicClouds.push(dust);
    group.add(backdrop, ship, dust);
    return group;
  }

  private buildUnknownSilhouette(): THREE.Group {
    const group = new THREE.Group();
    for (let index = 0; index < 3; index += 1) {
      const phase = index * ((Math.PI * 2) / 3);
      const points: THREE.Vector3[] = [];
      for (let step = 0; step <= 14; step += 1) {
        const t = -0.72 + (step / 14) * 1.12;
        points.push(new THREE.Vector3(
          Math.cos(t + phase) * (0.72 + index * 0.06),
          Math.sin(t + phase) * (0.42 + index * 0.035),
          -0.35 - index * 0.09,
        ));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const arc = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color: 0xa7bad3,
          transparent: true,
          opacity: 0.06,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      arc.rotation.z = phase * 0.32;
      group.add(arc);
    }
    group.position.set(1.85, 0.72, -1.15);
    group.scale.setScalar(0.78);
    group.visible = false;
    return group;
  }

  private buildTwinkle(): THREE.Group {
    const group = new THREE.Group();
    group.name = "twinkle-reference-scene";
    const nebula = this.trackVisualAsset(createNebulaGalaxy({ seed: mixSeed(this.options.seed, 0x60), quality: this.options.quality }));
    const earth = createLivingEarth({ seed: mixSeed(this.options.seed, 0x61), quality: this.options.quality });
    earth.scale.setScalar(0.66);
    earth.position.set(-1.72, 0.72, -2.8);
    const waves = this.trackVisualAsset(createLifeWaveAccents({ seed: mixSeed(this.options.seed, 0x62), quality: this.options.quality }));
    const lights = pointCloud(mixSeed(this.options.seed, 0x63), 760, [[1, 0.85, 0.36], [0.4, 0.95, 0.86], [0.68, 0.74, 1]], [8.5, 5.5, 3.5], 0.055);
    this.dynamicClouds.push(lights);
    group.add(nebula, earth, waves, lights);
    return group;
  }

  private buildHumanGrammar(group: THREE.Group): void {
    const sunken = new THREE.Group();
    const vehicleFrame = rectilinearFrame(2.35, 1.18, 0.06, 0x6b94a3, 0.58);
    vehicleFrame.rotation.z = -0.12;
    sunken.add(vehicleFrame);
    for (let index = 0; index < 3; index += 1) {
      const seat = new THREE.Group();
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.42, 0.08), material(0x527384, 0.62));
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.3), material(0x527384, 0.62));
      base.position.set(0, -0.22, 0.11);
      seat.position.set(-0.64 + index * 0.64, -0.18, 0.04);
      seat.add(back, base);
      sunken.add(seat);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.035, 0.035), material(0xa0c3ca, 0.52));
    rail.position.set(0, 0.37, 0.06);
    sunken.add(rail);
    sunken.position.set(-1.15, 0.15, -1.05);
    sunken.rotation.z = -0.12;
    sunken.userData.visibleAt = 18;
    sunken.userData.visibleUntil = 36;
    group.add(sunken);
    const city = new THREE.Group();
    for (let i = 0; i < 18; i += 1) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.22 + (i % 3) * 0.1, 0.18 + (i % 5) * 0.1, 0.14), material(i % 4 === 0 ? 0xc88a68 : 0x8c6258, 0.68));
      slab.position.set(-2.5 + (i % 6) * 0.82, -1.2 + Math.floor(i / 6) * 0.65, -0.85);
      city.add(slab);
    }
    const cityFrame = rectilinearFrame(1.35, 1.35, 0.045, 0xf2b179, 0.7);
    cityFrame.position.set(1.55, 0.58, -0.55);
    const benchSeat = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.08, 0.24), material(0xa67b65, 0.74));
    benchSeat.position.set(-1.65, -0.92, -0.38);
    const benchBack = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.42, 0.06), material(0xa67b65, 0.64));
    benchBack.position.set(-1.65, -0.69, -0.5);
    city.add(cityFrame, benchSeat, benchBack);
    city.userData.visibleAt = 62;
    city.userData.visibleUntil = 88;
    group.add(city);
    const observatory = new THREE.Group();
    const observationFrame = rectilinearFrame(2.5, 1.5, 0.05, 0xa1a9bb, 0.72);
    const railUp = new THREE.Mesh(new THREE.BoxGeometry(0.055, 2.8, 0.05), material(0xa8b4c8, 0.62));
    railUp.rotation.z = -0.42;
    railUp.position.set(1.25, 0.4, -0.12);
    const amber = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.035, 0.035), material(0xffa947, 0.94, THREE.AdditiveBlending));
    amber.position.set(-0.55, -0.72, 0.08);
    observatory.add(observationFrame, railUp, amber);
    observatory.position.set(0, 0.1, -1.1);
    observatory.userData.visibleAt = 88;
    observatory.userData.visibleUntil = 130;
    group.add(observatory);
    const cockpit = new THREE.Group();
    const airlock = rectilinearFrame(0.9, 1.15, 0.05, 0xa4a9b8, 0.66);
    const emptySeat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.08), material(0x70798a, 0.66));
    emptySeat.position.set(-1.55, -0.42, 0);
    const signal = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.1, 0.04), material(0xffa947, 0.92, THREE.AdditiveBlending));
    signal.position.set(1.45, 0.45, 0);
    cockpit.add(airlock, emptySeat, signal);
    cockpit.position.set(0, 0, -0.65);
    cockpit.userData.visibleAt = 130;
    cockpit.userData.visibleUntil = 148;
    group.add(cockpit);
  }

  private buildPlayer(): void {
    const hero = createLuminousDropletHero({ seed: mixSeed(this.options.seed, 0x70), quality: this.options.quality });
    this.player.name = "player-luminous-droplet";
    this.player.userData.assetRole = "hero-runtime-root";
    this.player.add(...hero.children);
  }
}

export function createLonelyStarWorld(options: WorldOptions): LonelyStarWorld {
  return new LonelyStarWorld(options);
}
