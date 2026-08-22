import { BoxGeometry, Group, Mesh, Scene } from "three/webgpu";
import type { RailScenePointSnapshot } from "../camera";
import type { RenderLogicalResourceOwnership, RenderQualityProfile, VisualClock } from "../contracts";
import {
  chunkOwnerId,
  type ChunkGenerationToken,
  type ChunkGpuLease,
  type ChunkUploadJob,
  type ChunkUploadStepResult,
  type ChunkUploader,
  type GeneratedChunkPayload,
} from "../chunks";
import type { TslMaterialLibrary } from "../materials";
import {
  STORY_CHUNK_IDS,
  WORLD_MATERIAL_FAMILIES,
  type StoryChunkId,
} from "../../../world/v2";

const UINT32_SCALE = 1 / 0x1_0000_0000;
export const PRODUCTION_CHUNK_GPU_SLOTS = 4;

export interface ProductionThreeChunkUploaderOptions {
  /** Keep lifecycle ownership active while a dedicated Hero feature supplies art. */
  readonly presentRuntimeObjects?: boolean;
  /** Renderer-space Flow midpoint anchors copied from the canonical WorldPlan. */
  readonly chunkAnchors?: Readonly<Partial<Record<StoryChunkId, Readonly<RailScenePointSnapshot>>>>;
  /**
   * Chunks whose fixed-pool lifecycle remains active but whose generic box
   * presentation is replaced by an authored production slice.
   */
  readonly suppressedRuntimeChunkIds?: readonly StoryChunkId[];
}

export interface ThreeChunkSlotSnapshot {
  readonly slotId: number;
  readonly state: PoolSlotState;
  readonly chunkId: StoryChunkId | null;
  readonly active: boolean;
  readonly presented: boolean;
  readonly position: Readonly<RailScenePointSnapshot>;
}

export interface ThreeChunkUploaderSnapshot {
  readonly initialized: boolean;
  readonly runtimeStarted: boolean;
  readonly disposed: boolean;
  readonly poolSlots: number;
  readonly freeSlots: number;
  readonly createdJobs: number;
  readonly cancelledJobs: number;
  readonly completedLeases: number;
  readonly disposedLeases: number;
  readonly activeLeases: number;
  readonly ownedGeometries: number;
  readonly ownedObjects: number;
  readonly activeChunkIds: readonly StoryChunkId[];
  readonly chunkSlots: readonly Readonly<ThreeChunkSlotSnapshot>[];
}

interface Counters {
  createdJobs: number;
  cancelledJobs: number;
  completedLeases: number;
  disposedLeases: number;
  activeLeases: number;
}

type PoolSlotState = "prewarm" | "free" | "job" | "lease";

interface PoolSlot {
  readonly id: number;
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  state: PoolSlotState;
  ownerId: string | null;
  chunkId: StoryChunkId | null;
  active: boolean;
}

function leaseOwnership(
  ownerId: string,
  objectCount: number,
): Readonly<RenderLogicalResourceOwnership> {
  return Object.freeze({
    ownerId,
    // Geometry and materials belong to the fixed pool and material library.
    geometries: 0,
    textures: 0,
    renderTargets: 0,
    nodes: 0,
    objects: objectCount,
    bytes: 0,
  });
}

function sample01(payload: Readonly<GeneratedChunkPayload>, index: number): number {
  const buffer = payload.buffers[index % payload.buffers.length];
  if (!buffer) return 0.5;
  const values = new Uint32Array(buffer.buffer, 0, buffer.elementCount);
  return (values[index % values.length] ?? 0) * UINT32_SCALE;
}

class ThreeChunkLease {
  readonly #uploader: ProductionThreeChunkUploader;
  readonly #slot: PoolSlot;
  readonly #ownerId: string;
  readonly #facade: Readonly<ChunkGpuLease>;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(
    uploader: ProductionThreeChunkUploader,
    slot: PoolSlot,
    ownerId: string,
  ) {
    this.#uploader = uploader;
    this.#slot = slot;
    this.#ownerId = ownerId;
    this.#facade = Object.freeze({
      ownerId,
      ownership: leaseOwnership(ownerId, slot.meshes.length + 1),
      quality: (profile: Readonly<RenderQualityProfile>) => this.#quality(profile),
      setActive: (active: boolean) => this.#setActive(active),
      dispose: () => this.#dispose(),
    });
  }

  facade(): Readonly<ChunkGpuLease> {
    return this.#facade;
  }

  #quality(profile: Readonly<RenderQualityProfile>): void {
    if (!this.#disposed) this.#uploader.applySlotQuality(this.#slot, profile);
  }

  #setActive(active: boolean): void {
    if (!this.#disposed) this.#uploader.setSlotActive(this.#slot, this.#ownerId, active);
  }

  #dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = Promise.resolve().then(() => {
      if (this.#disposed) return;
      this.#uploader.releaseSlot(this.#slot, this.#ownerId);
      this.#disposed = true;
      this.#uploader.recordLeaseDisposed();
    });
    return this.#disposePromise;
  }
}

class ThreeChunkUploadJob {
  readonly #uploader: ProductionThreeChunkUploader;
  readonly #slot: PoolSlot;
  readonly #payload: Readonly<GeneratedChunkPayload>;
  readonly #ownerId: string;
  readonly #byteLength: number;
  readonly #facade: Readonly<ChunkUploadJob>;
  #stage = 0;
  #complete = false;
  #cancelPromise: Promise<void> | null = null;

  constructor(
    uploader: ProductionThreeChunkUploader,
    slot: PoolSlot,
    payload: Readonly<GeneratedChunkPayload>,
    token: Readonly<ChunkGenerationToken>,
  ) {
    this.#uploader = uploader;
    this.#slot = slot;
    this.#payload = payload;
    this.#ownerId = chunkOwnerId(token);
    this.#byteLength = payload.manifest.byteLength;
    this.#facade = Object.freeze({
      id: `${this.#ownerId}:three-upload`,
      ownerId: this.#ownerId,
      token: Object.freeze({ ...token }),
      byteLength: this.#byteLength,
      maximumSliceMs: 1,
      runSlice: (clock: VisualClock) => this.#runSlice(clock),
      cancel: () => this.#cancel(),
    });
  }

  facade(): Readonly<ChunkUploadJob> {
    return this.#facade;
  }

  #runSlice(clock: VisualClock): Readonly<ChunkUploadStepResult> {
    void clock;
    if (this.#complete || this.#slot.state !== "job" || this.#slot.ownerId !== this.#ownerId) {
      throw new Error("A completed or cancelled Three chunk upload cannot run another slice.");
    }
    const mesh = this.#slot.meshes[this.#stage];
    if (mesh) {
      const family = WORLD_MATERIAL_FAMILIES[this.#stage]!;
      mesh.visible = this.#payload.manifest.materialFamilies.includes(family);
      const azimuth = sample01(this.#payload, this.#stage * 3) * Math.PI * 2;
      const radius = 1.1 + sample01(this.#payload, this.#stage * 3 + 1) * 2.8;
      mesh.position.set(
        Math.cos(azimuth) * radius,
        (sample01(this.#payload, this.#stage * 3 + 2) - 0.5) * 3.4,
        Math.sin(azimuth) * radius * 0.42,
      );
      const scale = 0.34 + sample01(this.#payload, this.#stage * 5 + 4) * 0.9;
      mesh.scale.set(scale, scale * (0.55 + sample01(this.#payload, this.#stage + 17)), scale);
      mesh.rotation.set(azimuth * 0.17, azimuth, azimuth * 0.07);
      mesh.name = `gfx004:${this.#facade.token.chunkId}:${family}`;
      this.#stage += 1;
      return Object.freeze({ kind: "pending", uploadedBytes: 0 });
    }

    this.#slot.state = "lease";
    this.#slot.group.name = `gfx004:${this.#facade.token.chunkId}`;
    const lease = new ThreeChunkLease(this.#uploader, this.#slot, this.#ownerId);
    this.#complete = true;
    this.#uploader.recordLeaseCompleted();
    return Object.freeze({ kind: "complete", uploadedBytes: this.#byteLength, lease: lease.facade() });
  }

  #cancel(): Promise<void> {
    if (this.#cancelPromise) return this.#cancelPromise;
    this.#cancelPromise = Promise.resolve().then(() => {
      if (this.#complete) return;
      this.#uploader.releaseSlot(this.#slot, this.#ownerId);
      this.#complete = true;
      this.#uploader.recordJobCancelled();
    });
    return this.#cancelPromise;
  }
}

/**
 * Four fixed GPU slots are created before backend precompile. The pipeline's
 * precompile render makes their geometry/material topology resident; runtime
 * jobs only mutate one already-resident mesh transform per bounded slice.
 */
export class ProductionThreeChunkUploader implements ChunkUploader {
  readonly #scene: Scene;
  readonly #materials: TslMaterialLibrary;
  readonly #presentRuntimeObjects: boolean;
  readonly #suppressedRuntimeChunkIds: ReadonlySet<StoryChunkId>;
  readonly #chunkAnchors: Readonly<Partial<Record<StoryChunkId, Readonly<RailScenePointSnapshot>>>>;
  readonly #counters: Counters = {
    createdJobs: 0,
    cancelledJobs: 0,
    completedLeases: 0,
    disposedLeases: 0,
    activeLeases: 0,
  };
  #geometry: BoxGeometry | null = null;
  #slots: PoolSlot[] = [];
  #initialized = false;
  #runtimeStarted = false;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(
    scene: Scene,
    materials: TslMaterialLibrary,
    options: Readonly<ProductionThreeChunkUploaderOptions> = {},
  ) {
    this.#scene = scene;
    this.#materials = materials;
    this.#presentRuntimeObjects = options.presentRuntimeObjects ?? true;
    this.#suppressedRuntimeChunkIds = new Set(options.suppressedRuntimeChunkIds ?? []);
    const anchors: Partial<Record<StoryChunkId, Readonly<RailScenePointSnapshot>>> = {};
    for (const chunkId of STORY_CHUNK_IDS) {
      const anchor = options.chunkAnchors?.[chunkId];
      if (!anchor) continue;
      if (![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) {
        throw new RangeError(`Three chunk anchor ${chunkId} must be finite.`);
      }
      anchors[chunkId] = Object.freeze({ x: anchor.x, y: anchor.y, z: anchor.z });
    }
    this.#chunkAnchors = Object.freeze(anchors);
  }

  initializePool(): void {
    if (this.#initialized) return;
    if (this.#disposed) throw new Error("Cannot initialize a disposed Three chunk uploader.");
    const geometry = new BoxGeometry(0.72, 0.72, 0.72, 1, 1, 1);
    const slots: PoolSlot[] = [];
    try {
      for (let slotId = 0; slotId < PRODUCTION_CHUNK_GPU_SLOTS; slotId += 1) {
        const group = new Group();
        group.name = `gfx004:prewarm:${slotId}`;
        group.scale.setScalar(0.001);
        const meshes = WORLD_MATERIAL_FAMILIES.map((family) => {
          const mesh = new Mesh(geometry, this.#materials.resolve(family).material);
          mesh.name = `gfx004:prewarm:${slotId}:${family}`;
          mesh.frustumCulled = false;
          group.add(mesh);
          return mesh;
        });
        const slot: PoolSlot = {
          id: slotId,
          group,
          meshes: Object.freeze(meshes),
          state: "prewarm",
          ownerId: null,
          chunkId: null,
          active: true,
        };
        slots.push(slot);
        this.#scene.add(group);
      }
    } catch (error: unknown) {
      for (const slot of slots) {
        this.#scene.remove(slot.group);
        slot.group.clear();
      }
      geometry.dispose();
      throw error;
    }
    this.#geometry = geometry;
    this.#slots = slots;
    this.#initialized = true;
  }

  beginRuntime(): void {
    if (!this.#initialized || this.#disposed || this.#runtimeStarted) return;
    this.#runtimeStarted = true;
    for (const slot of this.#slots) {
      if (slot.state !== "prewarm") continue;
      this.#scene.remove(slot.group);
      slot.group.scale.setScalar(1);
      slot.group.visible = this.#presentRuntimeObjects;
      slot.active = false;
      slot.state = "free";
    }
  }

  quality(profile: Readonly<RenderQualityProfile>): void {
    if (!this.#initialized || this.#disposed) return;
    for (const slot of this.#slots) this.applySlotQuality(slot, profile);
  }

  applySlotQuality(slot: PoolSlot, profile: Readonly<RenderQualityProfile>): void {
    void profile;
    for (let index = 0; index < slot.meshes.length; index += 1) {
      const family = WORLD_MATERIAL_FAMILIES[index];
      const mesh = slot.meshes[index];
      if (family && mesh) mesh.material = this.#materials.resolve(family).material;
    }
  }

  createUploadJob(
    payload: Readonly<GeneratedChunkPayload>,
    token: Readonly<ChunkGenerationToken>,
  ): Readonly<ChunkUploadJob> {
    if (!this.#initialized || !this.#runtimeStarted || this.#disposed) {
      throw new Error("Three chunk GPU slots are not available for runtime uploads.");
    }
    const slot = this.#slots.find((candidate) => candidate.state === "free");
    if (!slot) throw new Error("The four prewarmed chunk GPU slots are occupied.");
    slot.state = "job";
    slot.ownerId = chunkOwnerId(token);
    slot.chunkId = token.chunkId;
    const anchor = this.#chunkAnchors[token.chunkId];
    slot.group.position.set(anchor?.x ?? 0, anchor?.y ?? 0, anchor?.z ?? 0);
    slot.group.name = `gfx004:uploading:${token.chunkId}`;
    this.#counters.createdJobs += 1;
    return new ThreeChunkUploadJob(this, slot, payload, token).facade();
  }

  setSlotActive(slot: PoolSlot, ownerId: string, active: boolean): void {
    this.#assertSlotOwner(slot, ownerId, "activate");
    if (slot.state !== "lease" || slot.active === active) return;
    if (active) {
      slot.group.visible = this.#slotPresented(slot);
      this.#scene.add(slot.group);
      this.#counters.activeLeases += 1;
    } else {
      this.#scene.remove(slot.group);
      this.#counters.activeLeases -= 1;
    }
    slot.active = active;
  }

  releaseSlot(slot: PoolSlot, ownerId: string): void {
    this.#assertSlotOwner(slot, ownerId, "release");
    if (slot.active) {
      this.#scene.remove(slot.group);
      this.#counters.activeLeases -= 1;
    }
    slot.active = false;
    slot.ownerId = null;
    slot.chunkId = null;
    slot.state = "free";
    slot.group.name = `gfx004:free:${slot.id}`;
    slot.group.visible = this.#presentRuntimeObjects;
    slot.group.position.set(0, 0, 0);
    slot.group.rotation.set(0, 0, 0);
    slot.group.scale.setScalar(1);
    for (const mesh of slot.meshes) {
      mesh.visible = true;
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.setScalar(1);
    }
  }

  recordJobCancelled(): void {
    this.#counters.cancelledJobs += 1;
  }

  recordLeaseCompleted(): void {
    this.#counters.completedLeases += 1;
  }

  recordLeaseDisposed(): void {
    this.#counters.disposedLeases += 1;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = Promise.resolve().then(() => {
      if (this.#disposed) return;
      const outstanding = this.#slots.filter((slot) => slot.state === "job" || slot.state === "lease").length;
      for (const slot of this.#slots) {
        this.#scene.remove(slot.group);
        slot.group.clear();
        slot.active = false;
        slot.ownerId = null;
        slot.chunkId = null;
        slot.state = "free";
      }
      this.#geometry?.dispose();
      this.#geometry = null;
      this.#slots = [];
      this.#counters.activeLeases = 0;
      this.#disposed = true;
      if (outstanding > 0) {
        throw new Error(`Three chunk uploader disposed with ${outstanding} outstanding slot owner(s).`);
      }
    });
    return this.#disposePromise;
  }

  snapshot(): Readonly<ThreeChunkUploaderSnapshot> {
    const chunkSlots = Object.freeze(this.#slots.map((slot) => Object.freeze({
      slotId: slot.id,
      state: slot.state,
      chunkId: slot.chunkId,
      active: slot.active,
      presented: slot.active && this.#slotPresented(slot),
      position: Object.freeze({
        x: slot.group.position.x,
        y: slot.group.position.y,
        z: slot.group.position.z,
      }),
    })));
    return Object.freeze({
      initialized: this.#initialized,
      runtimeStarted: this.#runtimeStarted,
      disposed: this.#disposed,
      poolSlots: this.#slots.length,
      freeSlots: this.#slots.filter((slot) => slot.state === "free").length,
      createdJobs: this.#counters.createdJobs,
      cancelledJobs: this.#counters.cancelledJobs,
      completedLeases: this.#counters.completedLeases,
      disposedLeases: this.#counters.disposedLeases,
      activeLeases: this.#counters.activeLeases,
      ownedGeometries: this.#geometry ? 1 : 0,
      ownedObjects: this.#slots.reduce((total, slot) => total + slot.meshes.length + 1, 0),
      activeChunkIds: Object.freeze(chunkSlots
        .filter((slot) => slot.state === "lease" && slot.active && slot.chunkId !== null)
        .map((slot) => slot.chunkId!)),
      chunkSlots,
    });
  }

  #assertSlotOwner(slot: PoolSlot, ownerId: string, operation: string): void {
    if (this.#disposed || slot.ownerId !== ownerId) {
      throw new Error(`Cannot ${operation} a Three chunk slot owned by another operation.`);
    }
  }

  #slotPresented(slot: Readonly<PoolSlot>): boolean {
    return this.#presentRuntimeObjects
      && slot.chunkId !== null
      && !this.#suppressedRuntimeChunkIds.has(slot.chunkId);
  }
}
