import { BoxGeometry, Material, MeshStandardNodeMaterial, Scene } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import type {
  RenderQualityProfile,
  RenderServiceInitializationContext,
  RendererApi,
} from "../../src/gfx/v2/contracts";
import {
  GFX005_MATERIAL_WARMUP_KIND,
  ProductionTslMaterialLibrary,
  captureWorldMaterialLibrary,
} from "../../src/gfx/v2/materials/tsl-material-library";
import { TSL_MATERIAL_VARIANT_IDS } from "../../src/gfx/v2/materials/contracts";
import { ownedAggregateError } from "../../src/gfx/v2/materials/failures";
import {
  WORLD_MATERIAL_FAMILIES,
  WORLD_MATERIAL_LIBRARY,
  type WorldMaterialFamily,
} from "../../src/world/v2";

const viewport = Object.freeze({ width: 800, height: 450, pixelRatio: 1 });

function context(actualApi: RendererApi): RenderServiceInitializationContext {
  return {
    viewport,
    backend: {
      facts: Object.freeze({
        requestedApi: actualApi,
        actualApi,
        adapter: null,
        device: null,
        fallback: false,
      }),
    } as RenderServiceInitializationContext["backend"],
    observer: { observe: vi.fn() },
  };
}

function quality(tier: RenderQualityProfile["tier"], temporal: boolean = true): RenderQualityProfile {
  return Object.freeze({
    tier,
    pixelRatio: 1,
    uploadBudgetMs: 4,
    features: Object.freeze({ temporal }),
  });
}

async function rejectionBeforeNextTask(promise: Promise<void>): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Expected bounded rejection before the next task."));
    }, 0);
    promise.then(
      () => {
        clearTimeout(timeout);
        reject(new Error("Expected rejection, received fulfillment."));
      },
      (error: unknown) => {
        clearTimeout(timeout);
        resolve(error);
      },
    );
  });
}

function installEmptyPrototypeIterator(prototype: object) {
  const defineProperty = Object.defineProperty;
  const original = Object.getOwnPropertyDescriptor(prototype, Symbol.iterator);
  let calls = 0;
  const emptyIterator = (): Iterator<unknown> => {
    calls += 1;
    return {
      next: () => ({ done: true, value: undefined }),
    };
  };
  Reflect.apply(defineProperty, Object, [
    prototype,
    Symbol.iterator,
    {
      configurable: true,
      enumerable: original?.enumerable ?? false,
      value: emptyIterator,
      writable: true,
    },
  ]);
  return {
    callCount(): number {
      return calls;
    },
    restore(): void {
      if (original) {
        Reflect.apply(defineProperty, Object, [prototype, Symbol.iterator, original]);
      } else {
        Reflect.deleteProperty(prototype, Symbol.iterator);
      }
    },
  };
}

describe("GFX-005 TSL material library", () => {
  it("captures the exact seven canonical descriptor families without aliases", () => {
    const captured = captureWorldMaterialLibrary(WORLD_MATERIAL_LIBRARY);
    expect(captured.map((descriptor) => descriptor.family)).toEqual(WORLD_MATERIAL_FAMILIES);
    expect(captured.map((descriptor) => descriptor.id)).toEqual(
      WORLD_MATERIAL_FAMILIES.map((family) => `material:${family}`),
    );
    expect(captured).toHaveLength(7);
    expect(Object.isFrozen(captured)).toBe(true);
    for (const descriptor of captured) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.baseColorLinearPermille)).toBe(true);
    }
  });

  it("rejects sparse, extra, accessor, symbol, and hostile descriptor input", () => {
    const sparse: unknown[] = [...WORLD_MATERIAL_LIBRARY];
    delete sparse[2];
    expect(() => captureWorldMaterialLibrary(sparse)).toThrow(/dense/);

    const extra = WORLD_MATERIAL_LIBRARY.map((descriptor) => ({
      ...descriptor,
      baseColorLinearPermille: [...descriptor.baseColorLinearPermille],
      roughnessPermille: [...descriptor.roughnessPermille],
      metalnessPermille: [...descriptor.metalnessPermille],
      transmissionPermille: [...descriptor.transmissionPermille],
      emissionLinearPermille: [...descriptor.emissionLinearPermille],
    }));
    Object.defineProperty(extra[0]!, "unexpected", { value: true, enumerable: true });
    expect(() => captureWorldMaterialLibrary(extra)).toThrow(/canonical fields/);

    const accessor = WORLD_MATERIAL_LIBRARY.map((descriptor) => ({
      ...descriptor,
      baseColorLinearPermille: [...descriptor.baseColorLinearPermille],
      roughnessPermille: [...descriptor.roughnessPermille],
      metalnessPermille: [...descriptor.metalnessPermille],
      transmissionPermille: [...descriptor.transmissionPermille],
      emissionLinearPermille: [...descriptor.emissionLinearPermille],
    }));
    const getter = vi.fn(() => "material:water");
    Object.defineProperty(accessor[0]!, "id", { enumerable: true, configurable: true, get: getter });
    expect(() => captureWorldMaterialLibrary(accessor)).toThrow(/own data property/);
    expect(getter).not.toHaveBeenCalled();

    const symbol: unknown[] = [...WORLD_MATERIAL_LIBRARY];
    Object.defineProperty(symbol, Symbol("hidden"), { value: true });
    expect(() => captureWorldMaterialLibrary(symbol)).toThrow(/symbol/);

    const sentinel = new Error("proxy ownKeys trap");
    const hostile = new Proxy([...WORLD_MATERIAL_LIBRARY], {
      ownKeys() { throw sentinel; },
    });
    expect(() => captureWorldMaterialLibrary(hostile)).toThrow(sentinel);

    const ordinaryGet = vi.fn(() => {
      throw new Error("ordinary array get must not run");
    });
    const descriptorOnly = new Proxy([...WORLD_MATERIAL_LIBRARY], { get: ordinaryGet });
    expect(captureWorldMaterialLibrary(descriptorOnly)).toHaveLength(7);
    expect(ordinaryGet).not.toHaveBeenCalled();
  });

  it("captures all descriptors without trusting Array prototype methods after a trap", async () => {
    const originalMapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "map")!;
    const originalMap = originalMapDescriptor.value as typeof Array.prototype.map;
    let mapCalls = 0;
    const statefulMap = vi.fn(function (
      this: unknown[],
      callback: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown,
    ): unknown[] {
      mapCalls += 1;
      if (mapCalls === 1) {
        return Reflect.apply(originalMap, this, [callback, thisArg]) as unknown[];
      }
      return [];
    });
    let installed = false;
    const hostile = new Proxy([...WORLD_MATERIAL_LIBRARY], {
      ownKeys(target) {
        if (!installed) {
          installed = true;
          Object.defineProperty(Array.prototype, "map", {
            ...originalMapDescriptor,
            value: statefulMap,
          });
        }
        return Reflect.ownKeys(target);
      },
    });
    let captured: readonly Readonly<(typeof WORLD_MATERIAL_LIBRARY)[number]>[];
    try {
      captured = captureWorldMaterialLibrary(hostile);
    } finally {
      Object.defineProperty(Array.prototype, "map", originalMapDescriptor);
    }

    expect(installed).toBe(true);
    expect(statefulMap).not.toHaveBeenCalled();
    expect(captured).toHaveLength(7);
    expect(Object.isFrozen(captured)).toBe(true);
    for (const descriptor of captured) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.baseColorLinearPermille)).toBe(true);
    }

    const library = new ProductionTslMaterialLibrary({ descriptors: captured });
    await library.initialize(context("WebGPU"));
    const manifest = library.variantManifest();
    const passes = library.warmupPasses();
    expect(manifest).toHaveLength(14);
    expect(passes).toHaveLength(14);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(passes)).toBe(true);
    expect(manifest.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(passes.every((pass) => Object.isFrozen(pass))).toBe(true);
    expect(library.snapshot()).toMatchObject({
      state: "ready",
      createdMaterials: 14,
      ownedMaterials: 14,
      warmupPasses: 14,
    });
    await library.dispose();
  });

  it("initializes the exact closed topology after a descriptor ownKeys trap poisons Array iteration", async () => {
    const originalIterator = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    );
    const descriptors = WORLD_MATERIAL_LIBRARY.map((descriptor) => ({
      ...descriptor,
      baseColorLinearPermille: [...descriptor.baseColorLinearPermille],
      roughnessPermille: [...descriptor.roughnessPermille],
      metalnessPermille: [...descriptor.metalnessPermille],
      transmissionPermille: [...descriptor.transmissionPermille],
      emissionLinearPermille: [...descriptor.emissionLinearPermille],
    }));
    let poison: ReturnType<typeof installEmptyPrototypeIterator> | undefined;
    descriptors[0] = new Proxy(descriptors[0]!, {
      ownKeys(target) {
        if (!poison) poison = installEmptyPrototypeIterator(Array.prototype);
        return Reflect.ownKeys(target);
      },
    });
    let library!: ProductionTslMaterialLibrary;
    let ready!: ReturnType<ProductionTslMaterialLibrary["snapshot"]>;
    let manifest!: ReturnType<ProductionTslMaterialLibrary["variantManifest"]>;
    let passes!: ReturnType<ProductionTslMaterialLibrary["warmupPasses"]>;
    let initialization!: Promise<void>;
    try {
      library = new ProductionTslMaterialLibrary({ descriptors });
      initialization = library.initialize(context("WebGPU"));
      ready = library.snapshot();
      manifest = library.variantManifest();
      passes = library.warmupPasses([
        quality("low"),
        quality("balanced"),
        quality("high"),
      ]);
    } finally {
      poison?.restore();
    }
    await initialization;

    expect(poison).toBeDefined();
    expect(poison!.callCount()).toBe(0);
    expect(Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator))
      .toEqual(originalIterator);
    expect(ready).toMatchObject({
      state: "ready",
      actualApi: "WebGPU",
      activeVariantId: "webgpu-full",
      createdMaterials: 14,
      disposedMaterials: 0,
      ownedMaterials: 14,
      ownedGeometry: 1,
      warmupPasses: 14,
      variants: ["webgpu-full", "webgpu-lean"],
    });
    expect(manifest).toHaveLength(14);
    expect(new Set(manifest.map((entry) => entry.family))).toEqual(
      new Set(WORLD_MATERIAL_FAMILIES),
    );
    expect(passes).toHaveLength(14);
    expect(new Set(passes.map((pass) => `${pass.name}:${pass.variant}`)).size).toBe(14);
    await library.dispose();
  });

  it("creates and warms only the two closed topologies reachable by the actual backend", async () => {
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGPU"));
    const manifest = library.variantManifest();
    const passes = library.warmupPasses([quality("low"), quality("balanced"), quality("high")]);

    expect(library.snapshot()).toMatchObject({
      state: "ready",
      actualApi: "WebGPU",
      activeVariantId: "webgpu-full",
      createdMaterials: 14,
      disposedMaterials: 0,
      warmupPasses: 14,
      variants: ["webgpu-full", "webgpu-lean"],
    });
    expect(manifest).toHaveLength(14);
    expect(new Set(manifest.map((entry) => entry.family))).toEqual(new Set(WORLD_MATERIAL_FAMILIES));
    expect(new Set(manifest.map((entry) => entry.variantId))).toEqual(
      new Set(["webgpu-full", "webgpu-lean"]),
    );
    expect(passes).toHaveLength(14);
    expect(passes.every((pass) => pass.kind === GFX005_MATERIAL_WARMUP_KIND)).toBe(true);
    expect(passes.every((pass) => pass.variant === "webgpu-full" || pass.variant === "webgpu-lean")).toBe(true);

    for (const family of WORLD_MATERIAL_FAMILIES) {
      const handle = library.resolve(family);
      expect(handle.material.isNodeMaterial).toBe(true);
      expect((handle.material as { isShaderMaterial?: boolean }).isShaderMaterial).not.toBe(true);
      expect(Object.isFrozen(handle)).toBe(true);
      const material = handle.material as typeof handle.material & {
        transmission?: number;
        transmissionNode?: unknown;
        opacityNode?: unknown;
      };
      const descriptor = WORLD_MATERIAL_LIBRARY.find((candidate) => candidate.family === family)!;
      const descriptorTransmission = (
        descriptor.transmissionPermille[0] + descriptor.transmissionPermille[1]
      ) / 2000;
      if (descriptorTransmission > 0) {
        expect(material.transmission).toBe(0);
        expect(material.transmissionNode).toBeNull();
        expect(material.opacityNode).not.toBeNull();
        expect(material.transparent).toBe(true);
        expect(material.depthWrite).toBe(false);
      }
    }
    await library.dispose();
  });

  it("reserves disposal synchronously before initialization can allocate", async () => {
    const materialFactory = vi.fn(() => new MeshStandardNodeMaterial());
    const geometryConstruction = vi.spyOn(BoxGeometry.prototype, "setIndex");
    try {
      const library = new ProductionTslMaterialLibrary({
        createMaterial: materialFactory,
      });

      const first = library.dispose();
      const concurrent = library.dispose();
      const initialization = library.initialize(context("WebGPU"));

      expect(concurrent).toBe(first);
      expect(library.snapshot()).toMatchObject({
        state: "disposing",
        createdMaterials: 0,
        disposedMaterials: 0,
        ownedMaterials: 0,
        ownedGeometry: 0,
      });
      expect(materialFactory).not.toHaveBeenCalled();
      expect(geometryConstruction).not.toHaveBeenCalled();
      await expect(initialization).rejects.toThrow(/while disposing/);
      await first;
      expect(materialFactory).not.toHaveBeenCalled();
      expect(geometryConstruction).not.toHaveBeenCalled();
      expect(library.snapshot()).toMatchObject({
        state: "disposed",
        createdMaterials: 0,
        disposedMaterials: 0,
        ownedMaterials: 0,
        ownedGeometry: 0,
      });
      expect(library.dispose()).toBe(first);
    } finally {
      geometryConstruction.mockRestore();
    }
  });

  it("publishes initialization before a factory can request reentrant disposal", async () => {
    const geometryDispose = vi.spyOn(BoxGeometry.prototype, "dispose");
    const owner: { current: ProductionTslMaterialLibrary | null } = { current: null };
    let reentrantDispose: Promise<void> | undefined;
    let concurrentDispose: Promise<void> | undefined;
    const materialFactory = vi.fn(() => {
      const library = owner.current!;
      expect(library.snapshot().state).toBe("initializing");
      reentrantDispose = library.dispose();
      concurrentDispose = library.dispose();
      expect(library.snapshot().state).toBe("initializing");
      return null as unknown as MeshStandardNodeMaterial;
    });
    const library = new ProductionTslMaterialLibrary({
      createMaterial: materialFactory,
    });
    owner.current = library;

    try {
      const initialization = library.initialize(context("WebGPU"));
      expect(materialFactory).toHaveBeenCalledOnce();
      expect(concurrentDispose).toBe(reentrantDispose);
      await expect(initialization).rejects.toThrow(/initialization failed/);
      expect(reentrantDispose).toBeDefined();
      await reentrantDispose;
      expect(geometryDispose).toHaveBeenCalledOnce();
      expect(library.snapshot()).toMatchObject({
        state: "disposed",
        createdMaterials: 0,
        disposedMaterials: 0,
        ownedMaterials: 0,
        ownedGeometry: 0,
        warmupPasses: 0,
      });
      expect(library.dispose()).toBe(reentrantDispose);
    } finally {
      geometryDispose.mockRestore();
    }
  });

  it("does not commit backend facts or allocate when context inspection requests disposal", async () => {
    const materialFactory = vi.fn(() => new MeshStandardNodeMaterial());
    const geometryConstruction = vi.spyOn(BoxGeometry.prototype, "setIndex");
    const library = new ProductionTslMaterialLibrary({
      createMaterial: materialFactory,
    });
    const baseContext = context("WebGPU");
    let reentrantDispose: Promise<void> | undefined;
    let concurrentDispose: Promise<void> | undefined;
    const backendInspection = vi.fn(() => {
      expect(library.snapshot().state).toBe("initializing");
      reentrantDispose = library.dispose();
      concurrentDispose = library.dispose();
      expect(library.snapshot().state).toBe("initializing");
      return baseContext.backend;
    });
    const hostileContext = new Proxy(baseContext, {
      get(target, key, receiver) {
        if (key === "backend") return backendInspection();
        return Reflect.get(target, key, receiver);
      },
    });

    try {
      const initialization = library.initialize(hostileContext);
      expect(backendInspection).toHaveBeenCalledOnce();
      expect(concurrentDispose).toBe(reentrantDispose);
      await expect(initialization).rejects.toThrow(/initialization failed/);
      expect(reentrantDispose).toBeDefined();
      await reentrantDispose;
      expect(materialFactory).not.toHaveBeenCalled();
      expect(geometryConstruction).not.toHaveBeenCalled();
      expect(library.snapshot()).toMatchObject({
        state: "disposed",
        actualApi: null,
        activeVariantId: null,
        createdMaterials: 0,
        disposedMaterials: 0,
        ownedMaterials: 0,
        ownedGeometry: 0,
      });
      expect(library.dispose()).toBe(reentrantDispose);
    } finally {
      geometryConstruction.mockRestore();
    }
  });

  it("maps canonical base color as linear values and switches prebuilt variants without allocation", async () => {
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGL2"));
    const water = WORLD_MATERIAL_LIBRARY.find((descriptor) => descriptor.family === "water")!;

    library.quality(quality("balanced"));
    const full = library.resolve("water");
    const metadata = full.material.userData.gfx005 as {
      colorSpace: string;
      baseColorLinear: readonly number[];
    };
    expect(metadata.colorSpace).toBe("linear");
    expect(metadata.baseColorLinear).toEqual(water.baseColorLinearPermille.map((entry) => entry / 1000));

    const created = library.snapshot().createdMaterials;
    library.quality(quality("low", false));
    const lean = library.resolve("water");
    expect(lean.variantId).toBe("webgl2-lean");
    expect(lean.material).not.toBe(full.material);
    expect(library.snapshot().createdMaterials).toBe(created);
    library.quality(Object.freeze({ ...quality("high"), features: Object.freeze({ arbitrary: "new" }) }));
    expect(library.resolve("water").variantId).toBe("webgl2-full");
    expect(library.snapshot().createdMaterials).toBe(created);
    await library.dispose();
  });

  it("rejects accessor and reentrant quality input without committing a variant", async () => {
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGPU"));
    const initialVariant = library.snapshot().activeVariantId;

    const tierGetter = vi.fn(() => "low");
    const accessorProfile = {} as RenderQualityProfile;
    Object.defineProperty(accessorProfile, "tier", { get: tierGetter });
    expect(() => library.quality(accessorProfile)).toThrow(/own data property/);
    expect(tierGetter).not.toHaveBeenCalled();
    expect(library.snapshot().activeVariantId).toBe(initialVariant);

    const nestedDescriptor = vi.fn(() => Reflect.getOwnPropertyDescriptor(
      quality("low"),
      "tier",
    ));
    const nestedProfile = new Proxy(quality("low"), {
      getOwnPropertyDescriptor: nestedDescriptor,
    });
    const nestedFailures: unknown[] = [];
    const outerProfile = new Proxy(quality("low"), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "tier") {
          for (const operation of [
            () => library.quality(nestedProfile),
            () => library.resolve("water"),
            () => library.warmupPasses(),
            () => library.variantManifest(),
          ]) {
            try {
              operation();
            } catch (error: unknown) {
              nestedFailures.push(error);
            }
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(() => library.quality(outerProfile)).toThrow(/lost exclusive admission/);
    expect(nestedDescriptor).not.toHaveBeenCalled();
    expect(nestedFailures).toHaveLength(4);
    expect(nestedFailures.every((error) => (
      error instanceof Error && /quality selection is active/.test(error.message)
    ))).toBe(true);
    expect(library.snapshot().activeVariantId).toBe(initialVariant);
    await library.dispose();
  });

  it("revokes quality admission when its descriptor trap requests disposal", async () => {
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGPU"));
    const initialVariant = library.snapshot().activeVariantId;
    let disposal: Promise<void> | undefined;
    const profile = new Proxy(quality("low"), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "tier") disposal = library.dispose();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(() => library.quality(profile)).toThrow(/lost exclusive admission/);
    expect(library.snapshot()).toMatchObject({
      state: "disposing",
      activeVariantId: initialVariant,
    });
    expect(disposal).toBeDefined();
    expect(library.dispose()).toBe(disposal);
    await disposal;
    expect(library.snapshot()).toMatchObject({
      state: "disposed",
      activeVariantId: initialVariant,
      disposedMaterials: 14,
      ownedMaterials: 0,
      ownedGeometry: 0,
    });
  });

  it("keeps snapshots, warm-up copies, resolution, and disposal exact after quality poisons iterators", async () => {
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGPU"));
    let arrayPoison: ReturnType<typeof installEmptyPrototypeIterator> | undefined;
    let mapPoison: ReturnType<typeof installEmptyPrototypeIterator> | undefined;
    let descriptorCalls = 0;
    const profile = new Proxy(quality("low"), {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls += 1;
        if (key === "tier") {
          arrayPoison = installEmptyPrototypeIterator(Array.prototype);
          mapPoison = installEmptyPrototypeIterator(Map.prototype);
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    let selectedVariant: string | undefined;
    let ready!: ReturnType<ProductionTslMaterialLibrary["snapshot"]>;
    let passCount = -1;
    let manifestCount = -1;
    let disposal!: Promise<void>;
    let disposing!: ReturnType<ProductionTslMaterialLibrary["snapshot"]>;
    let disposed!: ReturnType<ProductionTslMaterialLibrary["snapshot"]>;
    let iteratorsRestored = false;
    const restoreIterators = (): void => {
      if (iteratorsRestored) return;
      mapPoison?.restore();
      arrayPoison?.restore();
      iteratorsRestored = true;
    };
    try {
      library.quality(profile);
      selectedVariant = library.resolve("water").variantId;
      ready = library.snapshot();
      passCount = library.warmupPasses([
        quality("low"),
        quality("balanced"),
        quality("high"),
      ]).length;
      manifestCount = library.variantManifest().length;
      disposal = library.dispose();
      disposing = library.snapshot();
      queueMicrotask(() => {
        queueMicrotask(restoreIterators);
      });
      await disposal;
      disposed = library.snapshot();
    } finally {
      restoreIterators();
    }

    expect(descriptorCalls).toBe(1);
    expect(arrayPoison).toBeDefined();
    expect(mapPoison).toBeDefined();
    expect(arrayPoison!.callCount()).toBe(0);
    expect(mapPoison!.callCount()).toBe(0);
    expect(selectedVariant).toBe("webgpu-lean");
    expect(passCount).toBe(14);
    expect(manifestCount).toBe(14);
    expect(ready).toMatchObject({
      state: "ready",
      createdMaterials: 14,
      disposedMaterials: 0,
      ownedMaterials: 14,
      ownedGeometry: 1,
      warmupPasses: 14,
      variants: ["webgpu-full", "webgpu-lean"],
    });
    expect(disposing).toMatchObject({
      state: "disposing",
      createdMaterials: 14,
      disposedMaterials: 0,
      ownedMaterials: 14,
      ownedGeometry: 1,
      warmupPasses: 14,
      variants: ["webgpu-full", "webgpu-lean"],
    });
    expect(disposed).toMatchObject({
      state: "disposed",
      createdMaterials: 14,
      disposedMaterials: 14,
      ownedMaterials: 0,
      ownedGeometry: 0,
      warmupPasses: 0,
      variants: [],
    });
  });

  it("keeps disposal library-owned and idempotent", async () => {
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGPU"));
    const materials = new Set<MeshStandardNodeMaterial>();
    for (const tier of ["high", "low"] as const) {
      library.quality(quality(tier));
      for (const family of WORLD_MATERIAL_FAMILIES) {
        materials.add(library.resolve(family).material);
      }
    }
    const disposals = [...materials].map((material) => {
      const listener = vi.fn();
      material.addEventListener("dispose", listener);
      return listener;
    });
    const first = library.dispose();
    const second = library.dispose();
    expect(second).toBe(first);
    await first;
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(library.snapshot()).toMatchObject({
      state: "disposed",
      createdMaterials: 14,
      disposedMaterials: 14,
      warmupPasses: 0,
    });
  });

  it("ignores an inherited call hook and still performs native disposal exactly once", async () => {
    const nativeDispose = Material.prototype.dispose;
    const originalPrototype = Object.getPrototypeOf(nativeDispose);
    const inheritedCall = vi.fn(() => vi.fn());
    const hostilePrototype = Object.create(originalPrototype) as object;
    Object.defineProperty(hostilePrototype, "call", {
      configurable: true,
      get: inheritedCall,
    });
    Object.setPrototypeOf(nativeDispose, hostilePrototype);
    try {
      const library = new ProductionTslMaterialLibrary();
      await library.initialize(context("WebGPU"));
      const materials = new Set<MeshStandardNodeMaterial>();
      for (const tier of ["high", "low"] as const) {
        library.quality(quality(tier));
        for (const family of WORLD_MATERIAL_FAMILIES) {
          materials.add(library.resolve(family).material);
        }
      }
      const nativeDisposals = [...materials].map((material) => {
        const listener = vi.fn();
        material.addEventListener("dispose", listener);
        return listener;
      });

      const disposal = library.dispose();
      expect(library.dispose()).toBe(disposal);
      await disposal;
      expect(inheritedCall).not.toHaveBeenCalled();
      expect(nativeDisposals.every((listener) => listener.mock.calls.length === 1)).toBe(true);
      expect(library.snapshot()).toMatchObject({
        state: "disposed",
        disposedMaterials: 14,
        ownedMaterials: 0,
        ownedGeometry: 0,
      });
    } finally {
      Object.setPrototypeOf(nativeDispose, originalPrototype);
    }
  });

  it("reserves ready disposal before same-turn material APIs can expose state", async () => {
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGPU"));
    const activeVariantId = library.snapshot().activeVariantId;

    const first = library.dispose();
    const concurrent = library.dispose();
    const qualityInspection = vi.fn((target: RenderQualityProfile, key: PropertyKey) => (
      Reflect.getOwnPropertyDescriptor(target, key)
    ));
    const uninspectableQuality = new Proxy(quality("low"), {
      getOwnPropertyDescriptor: qualityInspection,
    });
    expect(concurrent).toBe(first);
    expect(library.snapshot()).toMatchObject({
      state: "disposing",
      activeVariantId,
      createdMaterials: 14,
      disposedMaterials: 0,
      ownedMaterials: 14,
      ownedGeometry: 1,
    });
    expect(() => library.quality(uninspectableQuality)).toThrow(/while TSL materials are disposing/);
    expect(qualityInspection).not.toHaveBeenCalled();
    expect(() => library.resolve("water")).toThrow(/while TSL materials are disposing/);
    expect(() => library.warmupPasses()).toThrow(/while TSL materials are disposing/);
    expect(() => library.variantManifest()).toThrow(/while TSL materials are disposing/);
    expect(library.snapshot().activeVariantId).toBe(activeVariantId);

    await first;
    expect(library.snapshot()).toMatchObject({
      state: "disposed",
      disposedMaterials: 14,
      ownedMaterials: 0,
      ownedGeometry: 0,
      warmupPasses: 0,
    });
    expect(library.dispose()).toBe(first);
  });

  it("retries only a transiently retained material and stabilizes the successful promise", async () => {
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGPU"));
    const materials = new Set<MeshStandardNodeMaterial>();
    for (const tier of ["high", "low"] as const) {
      library.quality(quality(tier));
      for (const family of WORLD_MATERIAL_FAMILIES) {
        materials.add(library.resolve(family).material);
      }
    }
    const target = library.resolve("water").material;
    let failuresRemaining = 1;
    const disposals = new Map<MeshStandardNodeMaterial, ReturnType<typeof vi.fn>>();
    for (const material of materials) {
      const listener = material === target
        ? vi.fn(() => {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            throw new Error("transient material disposal failure");
          }
        })
        : vi.fn();
      material.addEventListener("dispose", listener);
      disposals.set(material, listener);
    }

    const first = library.dispose();
    expect(library.dispose()).toBe(first);
    let retry: Promise<void> | undefined;
    let concurrentRetry: Promise<void> | undefined;
    await first.catch((error: unknown) => {
      expect(error).toMatchObject({ message: "TSL material disposal failed." });
      expect(library.snapshot()).toMatchObject({
        state: "failed",
        disposedMaterials: 13,
        ownedMaterials: 1,
        ownedGeometry: 0,
      });
      retry = library.dispose();
      concurrentRetry = library.dispose();
      expect(library.snapshot().state).toBe("disposing");
    });

    expect(retry).toBeDefined();
    expect(retry).not.toBe(first);
    expect(concurrentRetry).toBe(retry);
    await retry;
    expect(disposals.get(target)).toHaveBeenCalledTimes(2);
    for (const [material, listener] of disposals) {
      if (material !== target) expect(listener).toHaveBeenCalledOnce();
    }
    expect(library.snapshot()).toMatchObject({
      state: "disposed",
      createdMaterials: 14,
      disposedMaterials: 14,
      ownedMaterials: 0,
      ownedGeometry: 0,
    });
    expect(library.dispose()).toBe(retry);
  });

  it("retries only transient geometry cleanup and never redisposes released materials", async () => {
    const originalGeometryDispose = BoxGeometry.prototype.dispose;
    let failuresRemaining = 1;
    const geometryDispose = vi.spyOn(BoxGeometry.prototype, "dispose").mockImplementation(
      function (this: BoxGeometry) {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("transient geometry disposal failure");
        }
        return Reflect.apply(originalGeometryDispose, this, []);
      },
    );
    try {
      const library = new ProductionTslMaterialLibrary();
      await library.initialize(context("WebGPU"));
      const materials = new Set<MeshStandardNodeMaterial>();
      for (const tier of ["high", "low"] as const) {
        library.quality(quality(tier));
        for (const family of WORLD_MATERIAL_FAMILIES) {
          materials.add(library.resolve(family).material);
        }
      }
      const disposals = [...materials].map((material) => {
        const listener = vi.fn();
        material.addEventListener("dispose", listener);
        return listener;
      });

      const first = library.dispose();
      expect(library.dispose()).toBe(first);
      await expect(first).rejects.toThrow(/material disposal failed/);
      expect(library.snapshot()).toMatchObject({
        state: "failed",
        disposedMaterials: 14,
        ownedMaterials: 0,
        ownedGeometry: 1,
      });

      const retry = library.dispose();
      expect(retry).not.toBe(first);
      expect(library.dispose()).toBe(retry);
      await retry;
      expect(geometryDispose).toHaveBeenCalledTimes(2);
      expect(disposals.every((listener) => listener.mock.calls.length === 1)).toBe(true);
      expect(library.snapshot()).toMatchObject({
        state: "disposed",
        createdMaterials: 14,
        disposedMaterials: 14,
        ownedMaterials: 0,
        ownedGeometry: 0,
      });
      expect(library.dispose()).toBe(retry);
    } finally {
      geometryDispose.mockRestore();
    }
  });

  it("rejects unproven custom factory outputs without invoking their cleanup", async () => {
    const ownDispose = vi.fn();
    const ownCall = vi.fn(() => vi.fn());
    Object.defineProperty(ownDispose, "call", {
      configurable: true,
      get: ownCall,
    });
    const nativeDispose = vi.fn();
    const factory = vi.fn(() => {
      const material = new MeshStandardNodeMaterial();
      material.addEventListener("dispose", nativeDispose);
      Object.defineProperty(material, "dispose", {
        configurable: true,
        value: ownDispose,
      });
      return material;
    });
    const library = new ProductionTslMaterialLibrary({
      createMaterial: factory,
    });

    await expect(library.initialize(context("WebGPU"))).rejects.toThrow(/initialization failed/);
    expect(factory).toHaveBeenCalledOnce();
    expect(ownDispose).not.toHaveBeenCalled();
    expect(ownCall).not.toHaveBeenCalled();
    expect(nativeDispose).not.toHaveBeenCalled();
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
    });

    const first = library.dispose();
    const second = library.dispose();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow(/material disposal failed/);
    expect(ownDispose).not.toHaveBeenCalled();
    expect(ownCall).not.toHaveBeenCalled();
    expect(nativeDispose).not.toHaveBeenCalled();
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
    const retry = library.dispose();
    expect(retry).not.toBe(first);
    expect(library.dispose()).toBe(retry);
    await expect(retry).rejects.toThrow(/material disposal failed/);
    expect(ownDispose).not.toHaveBeenCalled();
    expect(ownCall).not.toHaveBeenCalled();
    expect(nativeDispose).not.toHaveBeenCalled();
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
  });

  it("retains custom ownership when the factory poisons Array and Map iteration", async () => {
    let disposeCalls = 0;
    const dispose = (): void => {
      disposeCalls += 1;
    };
    const material = new MeshStandardNodeMaterial();
    Object.defineProperty(material, "dispose", { configurable: true, value: dispose });
    let factoryCalls = 0;
    let initializationArrayPoison: ReturnType<typeof installEmptyPrototypeIterator> | undefined;
    let initializationMapPoison: ReturnType<typeof installEmptyPrototypeIterator> | undefined;
    const factory = (): MeshStandardNodeMaterial => {
      factoryCalls += 1;
      initializationArrayPoison = installEmptyPrototypeIterator(Array.prototype);
      initializationMapPoison = installEmptyPrototypeIterator(Map.prototype);
      return material;
    };
    const library = new ProductionTslMaterialLibrary({ createMaterial: factory });
    let initialization!: Promise<void>;
    let disposal!: Promise<void>;
    let disposalFailure: unknown;
    let afterInitialization!: ReturnType<ProductionTslMaterialLibrary["snapshot"]>;
    let duringDisposal!: ReturnType<ProductionTslMaterialLibrary["snapshot"]>;
    let afterDisposal!: ReturnType<ProductionTslMaterialLibrary["snapshot"]>;
    try {
      initialization = library.initialize(context("WebGPU"));
      afterInitialization = library.snapshot();
    } finally {
      initializationMapPoison?.restore();
      initializationArrayPoison?.restore();
    }
    const initializationFailure = await rejectionBeforeNextTask(initialization);

    const disposalArrayPoison = installEmptyPrototypeIterator(Array.prototype);
    const disposalMapPoison = installEmptyPrototypeIterator(Map.prototype);
    let disposalIteratorsRestored = false;
    const restoreDisposalIterators = (): void => {
      if (disposalIteratorsRestored) return;
      disposalMapPoison.restore();
      disposalArrayPoison.restore();
      disposalIteratorsRestored = true;
    };
    try {
      disposal = library.dispose();
      duringDisposal = library.snapshot();
      queueMicrotask(() => {
        queueMicrotask(restoreDisposalIterators);
      });
      disposalFailure = await rejectionBeforeNextTask(disposal);
      afterDisposal = library.snapshot();
    } finally {
      restoreDisposalIterators();
    }

    expect(initializationFailure).toMatchObject({
      message: "TSL material initialization failed.",
    });
    expect(disposalFailure).toMatchObject({ message: "TSL material disposal failed." });
    expect(initializationArrayPoison).toBeDefined();
    expect(initializationMapPoison).toBeDefined();
    expect(initializationArrayPoison!.callCount()).toBe(0);
    expect(initializationMapPoison!.callCount()).toBe(0);
    expect(disposalArrayPoison.callCount()).toBe(0);
    expect(disposalMapPoison.callCount()).toBe(0);
    expect(factoryCalls).toBe(1);
    expect(disposeCalls).toBe(0);
    expect(afterInitialization).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
      ownedGeometry: 0,
      warmupPasses: 0,
      variants: [],
    });
    expect(duringDisposal).toMatchObject({
      state: "disposing",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
      ownedGeometry: 0,
      warmupPasses: 0,
      variants: [],
    });
    expect(afterDisposal).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
      ownedGeometry: 0,
      warmupPasses: 0,
      variants: [],
    });
  });

  it("never invokes an async-rejecting unsupported cleanup or creates an unhandled rejection", async () => {
    const asyncFailure = new Error("diagnostic cleanup rejection must never be created");
    const dispose = vi.fn(async () => {
      throw asyncFailure;
    });
    const material = new MeshStandardNodeMaterial();
    Object.defineProperty(material, "dispose", { configurable: true, value: dispose });
    const library = new ProductionTslMaterialLibrary({ createMaterial: () => material });
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      const failure = await rejectionBeforeNextTask(library.initialize(context("WebGPU")));
      expect(failure).toMatchObject({ message: "TSL material initialization failed." });
      expect(dispose).not.toHaveBeenCalled();
      expect(library.snapshot()).toMatchObject({
        state: "failed",
        createdMaterials: 1,
        disposedMaterials: 0,
        ownedMaterials: 1,
      });

      const disposalFailure = await rejectionBeforeNextTask(library.dispose());
      expect(disposalFailure).toMatchObject({ message: "TSL material disposal failed." });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(dispose).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      expect(library.snapshot()).toMatchObject({
        state: "failed",
        disposedMaterials: 0,
        ownedMaterials: 1,
      });
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("never invokes an async-fulfilling unsupported cleanup", async () => {
    const dispose = vi.fn(async () => undefined);
    const material = new MeshStandardNodeMaterial();
    Object.defineProperty(material, "dispose", { configurable: true, value: dispose });
    const library = new ProductionTslMaterialLibrary({ createMaterial: () => material });

    const failure = await rejectionBeforeNextTask(library.initialize(context("WebGPU")));
    expect(failure).toMatchObject({ message: "TSL material initialization failed." });
    expect(dispose).not.toHaveBeenCalled();
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
    const disposalFailure = await rejectionBeforeNextTask(library.dispose());
    expect(disposalFailure).toMatchObject({ message: "TSL material disposal failed." });
    expect(dispose).not.toHaveBeenCalled();
  });

  it("never invokes a never-settling unsupported cleanup", async () => {
    const dispose = vi.fn(() => new Promise<void>(() => undefined));
    const material = new MeshStandardNodeMaterial();
    Object.defineProperty(material, "dispose", { configurable: true, value: dispose });
    const library = new ProductionTslMaterialLibrary({ createMaterial: () => material });

    const failure = await rejectionBeforeNextTask(library.initialize(context("WebGPU")));
    expect(failure).toMatchObject({ message: "TSL material initialization failed." });
    expect(dispose).not.toHaveBeenCalled();
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
    const disposalFailure = await rejectionBeforeNextTask(library.dispose());
    expect(disposalFailure).toMatchObject({ message: "TSL material disposal failed." });
    expect(dispose).not.toHaveBeenCalled();
  });

  it("never invokes unsupported cleanup or reads a genuine Promise shadow then", async () => {
    const thenGetter = vi.fn(() => {
      throw new Error("shadow then getter must not run");
    });
    const cleanupResult = Promise.resolve();
    Object.defineProperty(cleanupResult, "then", {
      configurable: true,
      get: thenGetter,
    });
    const dispose = vi.fn(() => cleanupResult);
    const material = new MeshStandardNodeMaterial();
    Object.defineProperty(material, "dispose", { configurable: true, value: dispose });
    const library = new ProductionTslMaterialLibrary({ createMaterial: () => material });

    const failure = await rejectionBeforeNextTask(library.initialize(context("WebGPU")));
    expect(failure).toMatchObject({ message: "TSL material initialization failed." });
    expect(thenGetter).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
    const disposalFailure = await rejectionBeforeNextTask(library.dispose());
    expect(disposalFailure).toMatchObject({ message: "TSL material disposal failed." });
    expect(thenGetter).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("never invokes an unsupported cleanup returning a hostile thenable", async () => {
    const thenGetter = vi.fn(() => {
      throw new Error("hostile then getter must not run");
    });
    const hostileThenable = Object.create(null) as object;
    Object.defineProperty(hostileThenable, "then", {
      configurable: true,
      get: thenGetter,
    });
    const dispose = vi.fn(() => hostileThenable);
    const material = new MeshStandardNodeMaterial();
    Object.defineProperty(material, "dispose", { configurable: true, value: dispose });
    const library = new ProductionTslMaterialLibrary({ createMaterial: () => material });

    const failure = await rejectionBeforeNextTask(library.initialize(context("WebGPU")));
    expect(failure).toMatchObject({ message: "TSL material initialization failed." });
    expect(thenGetter).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
    const disposalFailure = await rejectionBeforeNextTask(library.dispose());
    expect(disposalFailure).toMatchObject({ message: "TSL material disposal failed." });
    expect(thenGetter).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("never invokes cleanup that would create a rejected Promise with a hostile constructor", async () => {
    const constructorGetter = vi.fn(() => {
      throw new Error("hostile Promise constructor getter must not run");
    });
    let constructedPromises = 0;
    const dispose = vi.fn(() => {
      constructedPromises += 1;
      const result = Promise.reject(new Error("must never become unhandled"));
      Object.defineProperty(result, "constructor", {
        configurable: true,
        get: constructorGetter,
      });
      return result;
    });
    const material = new MeshStandardNodeMaterial();
    Object.defineProperty(material, "dispose", { configurable: true, value: dispose });
    const library = new ProductionTslMaterialLibrary({ createMaterial: () => material });
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      const failure = await rejectionBeforeNextTask(library.initialize(context("WebGPU")));
      expect(failure).toMatchObject({ message: "TSL material initialization failed." });
      const disposalFailure = await rejectionBeforeNextTask(library.dispose());
      expect(disposalFailure).toMatchObject({ message: "TSL material disposal failed." });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(dispose).not.toHaveBeenCalled();
      expect(constructedPromises).toBe(0);
      expect(constructorGetter).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      expect(library.snapshot()).toMatchObject({
        state: "failed",
        createdMaterials: 1,
        disposedMaterials: 0,
        ownedMaterials: 1,
      });
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("never accepts spoofed listener push plus dispatch bypass as disposal proof", async () => {
    const ownDispose = vi.fn();
    const bypassedDispatch = vi.fn();
    const nativeDispose = vi.fn();
    const spoofedIndexOf = vi.fn(() => -1);
    const spoofedPush = vi.fn((listener: () => void) => {
      listener();
      return 1;
    });
    const spoofedSplice = vi.fn();
    const fakeListenerRegistry = {
      dispose: {
        indexOf: spoofedIndexOf,
        push: spoofedPush,
        splice: spoofedSplice,
      },
    };
    const material = new MeshStandardNodeMaterial();
    material.addEventListener("dispose", nativeDispose);
    Object.defineProperty(material, "dispose", {
      configurable: true,
      value: ownDispose,
    });
    const proxy = new Proxy(material, {
      get(target, key, receiver) {
        if (key === "_listeners") return fakeListenerRegistry;
        if (key === "dispatchEvent") return bypassedDispatch;
        return Reflect.get(target, key, receiver);
      },
    });
    const factory = vi.fn(() => proxy);
    const library = new ProductionTslMaterialLibrary({
      createMaterial: factory,
    });

    await expect(library.initialize(context("WebGPU"))).rejects.toThrow(/initialization failed/);
    expect(factory).toHaveBeenCalledOnce();
    expect(ownDispose).not.toHaveBeenCalled();
    expect(spoofedIndexOf).not.toHaveBeenCalled();
    expect(spoofedPush).not.toHaveBeenCalled();
    expect(spoofedSplice).not.toHaveBeenCalled();
    expect(bypassedDispatch).not.toHaveBeenCalled();
    expect(nativeDispose).not.toHaveBeenCalled();
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
  });

  it("unwinds internal partial initialization and retries failed native cleanup honestly", async () => {
    const disposalEvents: ReturnType<typeof vi.fn>[] = [];
    const failingDisposeEvent = vi.fn(() => {
      throw new Error("partial material cleanup failed");
    });
    const external = new Error("factory failed") as Error & { cause?: unknown };
    external.cause = external;
    let materialAdds = 0;
    const originalAdd = Scene.prototype.add;
    const addSpy = vi.spyOn(Scene.prototype, "add").mockImplementation(function (this: Scene, ...objects) {
      const material = objects.length === 1
        ? (objects[0] as unknown as { material?: MeshStandardNodeMaterial }).material
        : undefined;
      if (material) {
        materialAdds += 1;
        const disposalEvent = materialAdds === 1 ? failingDisposeEvent : vi.fn();
        disposalEvents.push(disposalEvent);
        material.addEventListener("dispose", disposalEvent);
        if (materialAdds === 4) throw external;
      }
      return originalAdd.apply(this, objects);
    });
    const library = new ProductionTslMaterialLibrary();

    let failure: unknown;
    try {
      failure = await library.initialize(context("WebGPU")).catch((error: unknown) => error);
    } finally {
      addSpy.mockRestore();
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen((failure as AggregateError).errors)).toBe(true);
    expect(Object.isFrozen((failure as AggregateError).errors[0])).toBe(true);
    expect((failure as AggregateError).errors[0]).not.toBe(external);
    expect(materialAdds).toBe(4);
    expect(disposalEvents).toHaveLength(4);
    expect(failingDisposeEvent).toHaveBeenCalledOnce();
    expect(disposalEvents.slice(1).every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    external.message = "mutated after capture";
    expect(JSON.stringify((failure as AggregateError).errors)).not.toContain("mutated after capture");
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 4,
      disposedMaterials: 3,
      ownedMaterials: 1,
      ownedGeometry: 0,
    });
    const first = library.dispose();
    const second = library.dispose();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow(/material disposal failed/);
    expect(failingDisposeEvent).toHaveBeenCalledTimes(2);
    expect(library.snapshot()).toMatchObject({
      state: "failed",
      disposedMaterials: 3,
      ownedMaterials: 1,
      ownedGeometry: 0,
    });
  });

  it("never invokes hostile disposal getters or brand traps and retains opaque obligations", async () => {
    const getter = vi.fn(() => {
      throw new Error("dispose getter must not run");
    });
    const disposeEvent = vi.fn();
    const accessorMaterial = new MeshStandardNodeMaterial();
    accessorMaterial.addEventListener("dispose", disposeEvent);
    Object.defineProperty(accessorMaterial, "dispose", {
      configurable: true,
      get: getter,
    });
    const accessorLibrary = new ProductionTslMaterialLibrary({
      createMaterial: () => accessorMaterial,
    });

    await expect(accessorLibrary.initialize(context("WebGPU"))).rejects.toThrow(
      /initialization failed/,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(disposeEvent).not.toHaveBeenCalled();
    expect(accessorLibrary.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
    });

    const capturedDispose = vi.fn();
    const nativeDisposeEvent = vi.fn();
    const ordinaryGets = vi.fn();
    const descriptorReads = vi.fn(() => {
      throw new Error("property descriptor inspection rejected");
    });
    const prototypeReads = vi.fn(() => {
      throw new Error("prototype inspection rejected");
    });
    const opaqueTarget = new MeshStandardNodeMaterial();
    opaqueTarget.addEventListener("dispose", nativeDisposeEvent);
    Object.defineProperty(opaqueTarget, "dispose", {
      configurable: true,
      value: capturedDispose,
    });
    const proxy = new Proxy(
      opaqueTarget,
      {
        get: ordinaryGets,
        getOwnPropertyDescriptor: descriptorReads,
        getPrototypeOf: prototypeReads,
      },
    );
    const proxyLibrary = new ProductionTslMaterialLibrary({
      createMaterial: () => proxy as unknown as MeshStandardNodeMaterial,
    });

    await expect(proxyLibrary.initialize(context("WebGPU"))).rejects.toThrow(
      /initialization failed/,
    );
    expect(ordinaryGets).not.toHaveBeenCalled();
    expect(descriptorReads).not.toHaveBeenCalled();
    expect(prototypeReads).not.toHaveBeenCalled();
    expect(capturedDispose).not.toHaveBeenCalled();
    expect(nativeDisposeEvent).not.toHaveBeenCalled();
    expect(proxyLibrary.snapshot()).toMatchObject({
      state: "failed",
      createdMaterials: 1,
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
    const first = proxyLibrary.dispose();
    const second = proxyLibrary.dispose();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow(/material disposal failed/);
    expect(ordinaryGets).not.toHaveBeenCalled();
    expect(descriptorReads).not.toHaveBeenCalled();
    expect(prototypeReads).not.toHaveBeenCalled();
    expect(capturedDispose).not.toHaveBeenCalled();
    expect(nativeDisposeEvent).not.toHaveBeenCalled();
    expect(proxyLibrary.snapshot()).toMatchObject({
      state: "failed",
      disposedMaterials: 0,
      ownedMaterials: 1,
    });
  });

  it("moves to failed when explicit disposal fails and preserves promise identity", async () => {
    const failure = new Error("material dispose failed");
    const failingDisposeEvent = vi.fn(() => {
      throw failure;
    });
    const injectedNoop = vi.fn();
    const library = new ProductionTslMaterialLibrary();
    await library.initialize(context("WebGPU"));
    const material = library.resolve("water").material;
    material.addEventListener("dispose", failingDisposeEvent);
    Object.defineProperty(material, "dispose", {
      configurable: true,
      value: injectedNoop,
    });

    const first = library.dispose();
    const second = library.dispose();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow(/material disposal failed/);
    expect(failingDisposeEvent).toHaveBeenCalledOnce();
    expect(injectedNoop).not.toHaveBeenCalled();
    expect(library.snapshot().state).toBe("failed");
    expect(library.snapshot().ownedMaterials).toBe(1);
    expect(library.snapshot().disposedMaterials).toBe(13);
  });

  it("marks bounded failure-list truncation instead of silently dropping evidence", () => {
    const failure = ownedAggregateError(
      Array.from({ length: 20 }, (_, index) => new Error(`failure ${index}`)),
      "bounded failures",
    );
    expect(failure.errors).toHaveLength(16);
    expect(failure.errors.at(-1)).toMatchObject({
      kind: "truncated",
      type: "failure-list",
      value: "5 additional failures omitted",
    });
    expect(Object.isFrozen(failure.errors.at(-1))).toBe(true);
  });

  it("copies nested AggregateError lists instead of retaining caller-owned errors", () => {
    const nested = new Error("nested original");
    const external = new AggregateError([nested], "outer original");
    const failure = ownedAggregateError([external], "captured");
    nested.message = "nested mutated";
    external.errors[0] = new Error("replacement");

    expect(JSON.stringify(failure.errors)).toContain("nested original");
    expect(JSON.stringify(failure.errors)).not.toContain("nested mutated");
    expect(JSON.stringify(failure.errors)).not.toContain("replacement");
    const captured = failure.errors[0] as { errors?: readonly unknown[] };
    expect(Object.isFrozen(captured.errors)).toBe(true);
  });

  it("removes the live V8 stack from the final frozen failure wrapper", () => {
    const previousPrepareStackTrace = Object.getOwnPropertyDescriptor(
      Error,
      "prepareStackTrace",
    );
    const prepareStackTrace = vi.fn(() => "S".repeat(2_000_000));
    try {
      Object.defineProperty(Error, "prepareStackTrace", {
        configurable: true,
        writable: true,
        value: prepareStackTrace,
      });
      const failure = ownedAggregateError([], "stackless failure wrapper");

      expect(failure).toBeInstanceOf(AggregateError);
      expect(Object.getOwnPropertyDescriptor(failure, "stack")).toBeUndefined();
      expect(failure.stack).toBeUndefined();
      expect(prepareStackTrace).not.toHaveBeenCalled();
      expect(Object.isFrozen(failure)).toBe(true);
      expect(Object.isFrozen(failure.errors)).toBe(true);
    } finally {
      if (previousPrepareStackTrace) {
        Object.defineProperty(Error, "prepareStackTrace", previousPrepareStackTrace);
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
    }
    expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"))
      .toEqual(previousPrepareStackTrace);
  });

  it("drops forced huge nested stacks while preserving bounded detached evidence", () => {
    const previousPrepareStackTrace = Object.getOwnPropertyDescriptor(
      Error,
      "prepareStackTrace",
    );
    const huge = "N".repeat(2_000_000);
    const prepareStackTrace = vi.fn(() => huge);
    try {
      Object.defineProperty(Error, "prepareStackTrace", {
        configurable: true,
        writable: true,
        value: prepareStackTrace,
      });
      const rawLeaf = new Error(huge);
      const getterZero = vi.fn(() => rawLeaf);
      const rawEntries = new Array<unknown>(4);
      Object.defineProperty(rawEntries, "0", {
        configurable: true,
        get: getterZero,
      });
      rawEntries[1] = rawLeaf;
      rawEntries[2] = rawLeaf;
      const rawNested = new AggregateError([], "raw nested", { cause: rawLeaf });
      Object.defineProperty(rawNested, "errors", {
        configurable: true,
        value: rawEntries,
        writable: true,
      });
      rawEntries[3] = rawNested;
      expect(rawLeaf.stack).toHaveLength(2_000_000);
      expect(rawNested.stack).toHaveLength(2_000_000);

      const failure = ownedAggregateError([rawNested, -0], huge);
      const root = failure.errors[0] as {
        readonly cause: object;
        readonly errors: readonly unknown[];
      };
      expect(failure).toBeInstanceOf(AggregateError);
      expect(Object.getOwnPropertyDescriptor(failure, "stack")).toBeUndefined();
      expect(failure.stack).toBeUndefined();
      expect(prepareStackTrace).toHaveBeenCalledTimes(2);
      expect(getterZero).not.toHaveBeenCalled();
      expect(root.errors[0]).toMatchObject({
        kind: "uninspectable",
        type: "accessor-failure-slot",
      });
      expect(root.errors[1]).toEqual(root.errors[2]);
      expect(root.errors[1]).not.toBe(root.errors[2]);
      expect(root.errors[3]).toMatchObject({ kind: "cycle", type: "object" });
      expect(Object.is((failure.errors[1] as { value: number }).value, -0)).toBe(true);

      const fields = [failure.message];
      const nodes: object[] = [failure, failure.errors];
      const pending: unknown[] = [...failure.errors];
      while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current !== "object" || current === null) continue;
        nodes.push(current);
        for (const key of ["value", "name", "message", "code"] as const) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
            fields.push(descriptor.value);
          }
        }
        const cause = Object.getOwnPropertyDescriptor(current, "cause");
        if (cause && "value" in cause) pending.push(cause.value);
        const errors = Object.getOwnPropertyDescriptor(current, "errors");
        if (errors && "value" in errors && Array.isArray(errors.value)) {
          nodes.push(errors.value);
          pending.push(...errors.value);
        }
      }
      expect(fields.reduce((sum, value) => sum + value.length, 0))
        .toBeLessThanOrEqual(4_096);
      for (const node of nodes) {
        expect(Object.getOwnPropertyDescriptor(node, "stack")).toBeUndefined();
        expect(Object.isFrozen(node)).toBe(true);
      }

      const captured = JSON.stringify({ message: failure.message, errors: failure.errors });
      rawLeaf.message = "mutated leaf";
      rawNested.message = "mutated aggregate";
      rawEntries[1] = new Error("replacement");
      expect(JSON.stringify({ message: failure.message, errors: failure.errors })).toBe(captured);
    } finally {
      if (previousPrepareStackTrace) {
        Object.defineProperty(Error, "prepareStackTrace", previousPrepareStackTrace);
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
    }
    expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"))
      .toEqual(previousPrepareStackTrace);
  });

  it("hard-bounds and truthfully snapshots every material failure evidence path", () => {
    const textFields = (failure: AggregateError): string[] => {
      const fields = [failure.message];
      const pending: unknown[] = [...failure.errors];
      while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current !== "object" || current === null) continue;
        for (const key of ["value", "name", "message", "code"] as const) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
            fields.push(descriptor.value);
          }
        }
        const cause = Object.getOwnPropertyDescriptor(current, "cause");
        if (cause && "value" in cause) pending.push(cause.value);
        const errors = Object.getOwnPropertyDescriptor(current, "errors");
        if (errors && "value" in errors && Array.isArray(errors.value)) {
          pending.push(...errors.value);
        }
      }
      return fields;
    };
    const evidenceNodes = (failure: AggregateError): readonly object[] => {
      const nodes: object[] = [failure, failure.errors];
      const pending: unknown[] = [...failure.errors];
      while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current !== "object" || current === null) continue;
        nodes.push(current);
        const cause = Object.getOwnPropertyDescriptor(current, "cause");
        if (cause && "value" in cause) pending.push(cause.value);
        const errors = Object.getOwnPropertyDescriptor(current, "errors");
        if (errors && "value" in errors && Array.isArray(errors.value)) {
          nodes.push(errors.value);
          pending.push(...errors.value);
        }
      }
      return nodes;
    };

    for (const length of [255, 256, 257]) {
      const messageFailure = ownedAggregateError([], "m".repeat(length));
      const primitiveFailure = ownedAggregateError(["p".repeat(length)], "");
      expect(messageFailure.message.length).toBeLessThanOrEqual(256);
      expect((primitiveFailure.errors[0] as { value?: string }).value?.length)
        .toBeLessThanOrEqual(256);
      if (length <= 256) {
        expect(messageFailure.message).toBe("m".repeat(length));
      } else {
        expect(messageFailure.message).toContain("[truncated ");
        expect(primitiveFailure.errors[0]).toMatchObject({ textTruncated: true });
      }
    }

    for (const total of [4_095, 4_096, 4_097]) {
      const inputs = Array.from({ length: 16 }, (_, index) => (
        "x".repeat(index < 15 ? 256 : total - (15 * 256))
      ));
      const failure = ownedAggregateError(inputs, "");
      const retainedUnits = textFields(failure).reduce((sum, value) => sum + value.length, 0);
      expect(retainedUnits).toBe(Math.min(total, 4_096));
      if (total > 4_096) {
        expect(failure.errors.at(-1)).toMatchObject({ textTruncated: true });
      }
    }

    const chargedRoots = Array.from({ length: 5 }, () => ({
      name: "n".repeat(256),
      message: "m".repeat(256),
      code: "c".repeat(256),
    }));
    const fixedTextPrimitives: readonly unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    const mixedBudgetFailure = ownedAggregateError(
      [...chargedRoots, ...fixedTextPrimitives],
      "a".repeat(256),
    );
    expect(textFields(mixedBudgetFailure).reduce((sum, value) => sum + value.length, 0))
      .toBe(4_096);
    expect(mixedBudgetFailure.errors.slice(5)).toHaveLength(11);
    for (const snapshot of mixedBudgetFailure.errors.slice(5)) {
      expect(snapshot).toMatchObject({ textTruncated: true });
      expect(snapshot).not.toHaveProperty("value");
    }

    const huge = "H".repeat(2_000_000);
    const hugeBigInt = BigInt(`1${"0".repeat(2_000)}`);
    const composite = {
      name: huge,
      message: huge,
      code: huge,
      cause: huge,
      errors: [huge, Symbol(huge), hugeBigInt, huge, huge],
    };
    const nestedAggregate = new AggregateError(
      [huge, Symbol(huge), hugeBigInt, huge, huge],
      huge,
      { cause: huge },
    );
    const hugeFailure = ownedAggregateError(
      [nestedAggregate, composite, huge, Symbol(huge), hugeBigInt],
      huge,
    );
    const hugeFields = textFields(hugeFailure);
    expect(Math.max(...hugeFields.map((value) => value.length))).toBeLessThanOrEqual(256);
    expect(hugeFields.reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(4_096);
    const hugeSerialized = JSON.stringify({
      message: hugeFailure.message,
      errors: hugeFailure.errors,
    });
    expect(hugeSerialized.length).toBeLessThan(50_000);
    expect(hugeSerialized).toContain("[truncated ");
    expect(hugeSerialized).toContain("bigint omitted beyond 128 decimal digits");
    expect(hugeSerialized).not.toContain("H".repeat(257));

    const bigintFailure = ownedAggregateError([
      BigInt("9".repeat(128)),
      BigInt(`1${"0".repeat(128)}`),
      BigInt(`-1${"0".repeat(128)}`),
    ], "");
    expect(bigintFailure.errors[0]).toMatchObject({ value: "9".repeat(128) });
    expect(bigintFailure.errors[1]).toMatchObject({
      value: "[bigint omitted beyond 128 decimal digits]",
    });
    expect(bigintFailure.errors[2]).toMatchObject({
      value: "-[bigint omitted beyond 128 decimal digits]",
    });

    const sixteen = ownedAggregateError(Array.from({ length: 16 }, () => "root"), "");
    const seventeen = ownedAggregateError(Array.from({ length: 17 }, () => "root"), "");
    expect(sixteen.errors).toHaveLength(16);
    expect(seventeen.errors).toHaveLength(16);
    expect(seventeen.errors.at(-1)).toMatchObject({
      kind: "truncated",
      value: "2 additional failures omitted",
    });

    const widthFour = ownedAggregateError([
      new AggregateError(Array.from({ length: 4 }, () => new Error("nested")), "four"),
    ], "");
    const widthFive = ownedAggregateError([
      new AggregateError(Array.from({ length: 5 }, () => new Error("nested")), "five"),
    ], "");
    expect((widthFour.errors[0] as { errors: readonly unknown[] }).errors).toHaveLength(4);
    expect((widthFive.errors[0] as { errors: readonly unknown[] }).errors.at(-1)).toMatchObject({
      kind: "truncated",
      value: "1 additional nested failures omitted",
    });

    const depthThree = { message: "depth three" } as { message: string; cause?: unknown };
    const depthTwo = { message: "depth two", cause: depthThree };
    const depthOne = { message: "depth one", cause: depthTwo };
    const depthRoot = { message: "depth root", cause: depthOne };
    const depthFailure = ownedAggregateError([depthRoot], "");
    const depthSnapshot = depthFailure.errors[0] as {
      cause: { cause: { cause: { kind: string } } };
    };
    expect(depthSnapshot.cause.cause.cause.kind).toBe("truncated");

    const shared = { message: "shared occurrence" };
    const slots = new Array<unknown>(4);
    slots[0] = shared;
    const accessor = vi.fn(() => shared);
    Object.defineProperty(slots, "2", { configurable: true, get: accessor });
    slots[3] = shared;
    const external = new AggregateError([], "slot source");
    Object.defineProperty(external, "errors", { configurable: true, value: slots });
    const occurrenceFailure = ownedAggregateError([shared, shared, external], "");
    const nestedSlots = (occurrenceFailure.errors[2] as { errors: readonly unknown[] }).errors;
    expect(occurrenceFailure.errors.slice(0, 2)).toEqual([
      expect.objectContaining({ message: "shared occurrence" }),
      expect.objectContaining({ message: "shared occurrence" }),
    ]);
    expect(nestedSlots).toEqual([
      expect.objectContaining({ message: "shared occurrence" }),
      expect.objectContaining({ type: "missing-failure-slot" }),
      expect.objectContaining({ type: "accessor-failure-slot" }),
      expect.objectContaining({ message: "shared occurrence" }),
    ]);
    expect(accessor).not.toHaveBeenCalled();
    const self: { message: string; cause?: unknown } = { message: "self" };
    self.cause = self;
    expect((ownedAggregateError([self], "").errors[0] as { cause: unknown }).cause)
      .toMatchObject({ kind: "cycle" });

    const fanout = (depth: number): { message: string; cause?: unknown; errors?: unknown[] } => {
      const node: { message: string; cause?: unknown; errors?: unknown[] } = {
        message: `fanout ${depth}`,
      };
      if (depth > 0) {
        node.cause = fanout(depth - 1);
        node.errors = Array.from({ length: 4 }, () => fanout(depth - 1));
      }
      return node;
    };
    const fanoutFailure = ownedAggregateError(
      Array.from({ length: 16 }, () => fanout(4)),
      "fanout",
    );
    const fanoutNodes = evidenceNodes(fanoutFailure);
    expect(fanoutNodes.filter((node) => (
      (node as { type?: string }).type === "evidence-budget"
    ))).toHaveLength(1);
    expect(fanoutNodes.filter((node) => "kind" in node)).toHaveLength(256);
    expect(textFields(fanoutFailure).reduce((sum, value) => sum + value.length, 0))
      .toBeLessThanOrEqual(4_096);
    expect(JSON.stringify(fanoutFailure.errors).length).toBeLessThan(50_000);
    for (const node of evidenceNodes(hugeFailure)) expect(Object.isFrozen(node)).toBe(true);

    shared.message = "mutated after capture";
    slots[0] = { message: "replacement" };
    expect(JSON.stringify(occurrenceFailure.errors)).toContain("shared occurrence");
    expect(JSON.stringify(occurrenceFailure.errors)).not.toContain("mutated after capture");
    expect(JSON.stringify(occurrenceFailure.errors)).not.toContain("replacement");
  });

  it("keeps the public topology vocabulary closed", () => {
    expect(TSL_MATERIAL_VARIANT_IDS).toEqual([
      "webgpu-full",
      "webgpu-lean",
      "webgl2-full",
      "webgl2-lean",
    ]);
    expect(new Set<WorldMaterialFamily>(WORLD_MATERIAL_FAMILIES).size).toBe(7);
  });
});
