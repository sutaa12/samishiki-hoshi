import { describe, expect, it } from "vitest";
import {
  Mesh,
  MeshStandardNodeMaterial,
  Scene,
  type Material,
} from "three/webgpu";
import type {
  RenderPass,
  RenderQualityProfile,
  RenderServiceInitializationContext,
  VisualClock,
} from "../../src/gfx/v2/contracts";
import {
  IncrementalChunkUploadQueue,
  generateChunkPayload,
  makeChunkGenerationToken,
} from "../../src/gfx/v2/chunks";
import type {
  TslMaterialHandle,
  TslMaterialLibrary,
  TslMaterialLibrarySnapshot,
} from "../../src/gfx/v2/materials";
import { ProductionThreeChunkUploader } from "../../src/gfx/v2/integration/three-chunk-uploader";
import {
  WORLD_GENERATOR_VERSION,
  WORLD_MATERIAL_FAMILIES,
  createWorldGenerationContext,
  digestWorldPlan,
  generateWorldPlan,
  type WorldMaterialFamily,
} from "../../src/world/v2";

const PLAN = generateWorldPlan(createWorldGenerationContext({
  worldSeed: 20_260_818,
  generatorVersion: WORLD_GENERATOR_VERSION,
}));
const PLAN_DIGEST = digestWorldPlan(PLAN);
const TOKEN = makeChunkGenerationToken({
  planDigest: PLAN_DIGEST,
  chunkId: "S08",
  epoch: 1,
  requestId: 1,
});
const PAYLOAD = generateChunkPayload(PLAN, TOKEN);
const CLOCK: Readonly<VisualClock> = Object.freeze({
  frame: 1,
  nowMs: 16,
  deltaSeconds: 0.016,
  elapsedSeconds: 0.016,
});

const HIGH: Readonly<RenderQualityProfile> = Object.freeze({
  tier: "high",
  pixelRatio: 1,
  uploadBudgetMs: 4,
  features: Object.freeze({ temporal: false }),
});

const LOW: Readonly<RenderQualityProfile> = Object.freeze({
  tier: "low",
  pixelRatio: 1,
  uploadBudgetMs: 4,
  features: Object.freeze({ temporal: false }),
});

class StubMaterialLibrary implements TslMaterialLibrary {
  readonly full = new MeshStandardNodeMaterial();
  readonly lean = new MeshStandardNodeMaterial();
  #active: Material = this.full;

  initialize(): void {}
  warmupPasses(): readonly RenderPass[] {
    return Object.freeze([]);
  }
  quality(profile: Readonly<RenderQualityProfile>): void {
    this.#active = profile.tier === "low" ? this.lean : this.full;
  }
  resolve(family: WorldMaterialFamily): Readonly<TslMaterialHandle> {
    return Object.freeze({
      id: `${family}:${this.#active === this.lean ? "lean" : "full"}`,
      family,
      variantId: this.#active === this.lean ? "webgl2-lean" : "webgl2-full",
      material: this.#active as MeshStandardNodeMaterial,
    });
  }
  variantManifest(): readonly [] {
    return Object.freeze([]);
  }
  snapshot(): Readonly<TslMaterialLibrarySnapshot> {
    return Object.freeze({
      state: "ready",
      actualApi: "WebGL2",
      activeVariantId: this.#active === this.lean ? "webgl2-lean" : "webgl2-full",
      createdMaterials: 2,
      disposedMaterials: 0,
      ownedMaterials: 2,
      ownedGeometry: 0,
      warmupPasses: 0,
      variants: Object.freeze(["webgl2-full", "webgl2-lean"] as const),
    });
  }
  dispose(): void {}
}

function finishJob(uploader: ProductionThreeChunkUploader) {
  const job = uploader.createUploadJob(PAYLOAD, TOKEN);
  let result = job.runSlice(CLOCK);
  let slices = 1;
  while (result.kind === "pending") {
    result = job.runSlice(CLOCK);
    slices += 1;
  }
  return { job, result, slices };
}

describe("ProductionThreeChunkUploader", () => {
  it("builds one inactive persistent-scene lease in bounded allocation slices", async () => {
    const scene = new Scene();
    const materials = new StubMaterialLibrary();
    const uploader = new ProductionThreeChunkUploader(scene, materials);
    const materialDisposals: string[] = [];
    materials.full.addEventListener("dispose", () => materialDisposals.push("full"));
    materials.lean.addEventListener("dispose", () => materialDisposals.push("lean"));

    uploader.initializePool();
    expect(scene.children).toHaveLength(4);
    uploader.quality(HIGH);
    uploader.beginRuntime();
    expect(scene.children).toEqual([]);
    const { job, result, slices } = finishJob(uploader);

    expect(job.maximumSliceMs).toBe(1);
    expect(slices).toBe(WORLD_MATERIAL_FAMILIES.length + 1);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("Expected a completed upload lease.");
    expect(result.uploadedBytes).toBe(PAYLOAD.manifest.byteLength);
    expect(scene.children).toEqual([]);
    expect(result.lease.ownership).toEqual({
      ownerId: job.ownerId,
      geometries: 0,
      textures: 0,
      renderTargets: 0,
      nodes: 0,
      objects: WORLD_MATERIAL_FAMILIES.length + 1,
      bytes: 0,
    });
    expect(uploader.snapshot()).toMatchObject({
      createdJobs: 1,
      cancelledJobs: 0,
      completedLeases: 1,
      activeLeases: 0,
      ownedGeometries: 1,
      ownedObjects: 4 * (WORLD_MATERIAL_FAMILIES.length + 1),
    });

    result.lease.setActive?.(true);
    expect(scene.children).toHaveLength(1);
    expect(uploader.snapshot().activeLeases).toBe(1);
    const meshes: Mesh[] = [];
    scene.traverse((object) => {
      if (object instanceof Mesh) meshes.push(object);
    });
    expect(meshes).toHaveLength(WORLD_MATERIAL_FAMILIES.length);
    expect(meshes.filter((mesh) => mesh.visible)).toHaveLength(PAYLOAD.manifest.materialFamilies.length);
    expect(meshes.every((mesh) => mesh.material === materials.full)).toBe(true);

    materials.quality(LOW);
    result.lease.quality?.(LOW);
    expect(meshes.every((mesh) => mesh.material === materials.lean)).toBe(true);
    materials.quality(HIGH);
    result.lease.quality?.(HIGH);
    expect(meshes.every((mesh) => mesh.material === materials.full)).toBe(true);

    const firstDispose = result.lease.dispose();
    expect(result.lease.dispose()).toBe(firstDispose);
    await firstDispose;
    expect(scene.children).toEqual([]);
    expect(materialDisposals).toEqual([]);
    expect(uploader.snapshot()).toMatchObject({
      disposedLeases: 1,
      activeLeases: 0,
      freeSlots: 4,
      ownedGeometries: 1,
      ownedObjects: 4 * (WORLD_MATERIAL_FAMILIES.length + 1),
    });
    await uploader.dispose();
    expect(uploader.snapshot()).toMatchObject({ ownedGeometries: 0, ownedObjects: 0 });
  });

  it("cancels partial allocation exactly once without claiming library materials", async () => {
    const scene = new Scene();
    const materials = new StubMaterialLibrary();
    const uploader = new ProductionThreeChunkUploader(scene, materials);
    uploader.initializePool();
    uploader.beginRuntime();
    const job = uploader.createUploadJob(PAYLOAD, TOKEN);

    expect(job.runSlice(CLOCK).kind).toBe("pending");
    const firstCancel = job.cancel();
    expect(job.cancel()).toBe(firstCancel);
    await firstCancel;

    expect(scene.children).toEqual([]);
    expect(uploader.snapshot()).toMatchObject({
      createdJobs: 1,
      cancelledJobs: 1,
      completedLeases: 0,
      disposedLeases: 0,
      activeLeases: 0,
      freeSlots: 4,
      ownedGeometries: 1,
      ownedObjects: 4 * (WORLD_MATERIAL_FAMILIES.length + 1),
    });
    expect(() => job.runSlice(CLOCK)).toThrow(/completed or cancelled/i);
    await uploader.dispose();
  });

  it("keeps chunk ownership live while a dedicated Hero feature hides placeholder objects", async () => {
    const scene = new Scene();
    const materials = new StubMaterialLibrary();
    const uploader = new ProductionThreeChunkUploader(scene, materials, {
      presentRuntimeObjects: false,
    });

    uploader.initializePool();
    expect(scene.children).toHaveLength(4);
    uploader.beginRuntime();
    expect(scene.children).toEqual([]);

    const { result } = finishJob(uploader);
    if (result.kind !== "complete") throw new Error("Expected a completed hidden upload lease.");
    result.lease.setActive?.(true);

    expect(scene.children).toHaveLength(1);
    expect(scene.children[0]?.visible).toBe(false);
    expect(uploader.snapshot()).toMatchObject({
      activeLeases: 1,
      completedLeases: 1,
      ownedGeometries: 1,
      ownedObjects: 4 * (WORLD_MATERIAL_FAMILIES.length + 1),
    });

    await result.lease.dispose();
    expect(scene.children).toEqual([]);
    await uploader.dispose();
    expect(uploader.snapshot()).toMatchObject({
      activeLeases: 0,
      ownedGeometries: 0,
      ownedObjects: 0,
    });
  });

  it("uses only the validated closed material-family inventory", () => {
    expect(PAYLOAD.manifest.materialFamilies.every((family) => (
      WORLD_MATERIAL_FAMILIES.includes(family)
    ))).toBe(true);
  });

  it("crosses the strict plain own-data upload job and lease boundary", async () => {
    const scene = new Scene();
    const materials = new StubMaterialLibrary();
    const uploader = new ProductionThreeChunkUploader(scene, materials);
    uploader.initializePool();
    uploader.beginRuntime();
    let now = 0;
    const queue = new IncrementalChunkUploadQueue(() => {
      now += 0.01;
      return now;
    });
    queue.initialize({} as RenderServiceInitializationContext);
    queue.quality(HIGH);

    const ticket = queue.enqueue(uploader.createUploadJob(PAYLOAD, TOKEN));
    while (queue.pendingCount() > 0) await queue.flush(CLOCK, HIGH);
    const result = await ticket.result;

    expect(result.kind).toBe("complete");
    expect(queue.snapshot()).toMatchObject({ completed: 1, failed: 0, orphanLeaseCount: 0 });
    if (result.kind !== "complete") throw new Error("Expected a completed strict-boundary lease.");
    result.lease.setActive?.(true);
    expect(scene.children).toHaveLength(1);
    await result.lease.dispose();
    await queue.dispose();
    await uploader.dispose();
    expect(scene.children).toEqual([]);
    expect(uploader.snapshot()).toMatchObject({
      activeLeases: 0,
      ownedGeometries: 0,
      ownedObjects: 0,
    });
  });
});
