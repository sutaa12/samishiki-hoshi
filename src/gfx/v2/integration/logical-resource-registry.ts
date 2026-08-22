import type {
  RenderLogicalResourceOwnership,
  RenderResourceRegistry,
  RenderResourceSnapshot,
} from "../contracts";

export interface LogicalResourceRegistrySnapshot {
  readonly initialized: boolean;
  readonly disposed: boolean;
  readonly owners: number;
  readonly adopted: number;
  readonly released: number;
  readonly bytes: number;
  readonly resources: Readonly<RenderResourceSnapshot>;
}

function safeCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`Logical resource ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function ownData(
  source: Readonly<RenderLogicalResourceOwnership>,
  key: keyof RenderLogicalResourceOwnership,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    throw new TypeError(`Logical resource ${key} could not be captured.`);
  }
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`Logical resource ${key} must be an own data property.`);
  }
  return descriptor.value;
}

function captureOwnership(
  ownership: Readonly<RenderLogicalResourceOwnership>,
): Readonly<RenderLogicalResourceOwnership> {
  const ownerId = ownData(ownership, "ownerId");
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new TypeError("Logical resource owner id is required.");
  }
  return Object.freeze({
    ownerId,
    geometries: safeCount(ownData(ownership, "geometries") as number, "geometries"),
    textures: safeCount(ownData(ownership, "textures") as number, "textures"),
    renderTargets: safeCount(ownData(ownership, "renderTargets") as number, "renderTargets"),
    nodes: safeCount(ownData(ownership, "nodes") as number, "nodes"),
    objects: safeCount(ownData(ownership, "objects") as number, "objects"),
    bytes: safeCount(ownData(ownership, "bytes") as number, "bytes"),
  });
}

export class LogicalChunkResourceRegistry implements RenderResourceRegistry {
  readonly #owners = new Map<string, Readonly<RenderLogicalResourceOwnership>>();
  #initialized = false;
  #disposed = false;
  #adopted = 0;
  #released = 0;
  #disposePromise: Promise<void> | null = null;

  initialize(): void {
    if (this.#disposed) throw new Error("Cannot initialize a disposed logical resource registry.");
    this.#initialized = true;
  }

  adopt(ownership: Readonly<RenderLogicalResourceOwnership>): void {
    if (!this.#initialized || this.#disposed) throw new Error("Logical resource registry is unavailable.");
    const captured = captureOwnership(ownership);
    if (this.#owners.has(captured.ownerId)) {
      throw new Error(`Logical resource owner already exists: ${captured.ownerId}.`);
    }
    this.#owners.set(captured.ownerId, captured);
    this.#adopted += 1;
  }

  releaseOwner(ownerId: string): void {
    if (this.#disposed) return;
    if (this.#owners.delete(ownerId)) this.#released += 1;
  }

  snapshot(): Readonly<RenderResourceSnapshot> {
    const resources = [...this.#owners.values()].reduce((total, ownership) => ({
      geometries: total.geometries + ownership.geometries,
      textures: total.textures + ownership.textures,
      renderTargets: total.renderTargets + ownership.renderTargets,
      programs: 0,
      nodes: total.nodes + ownership.nodes,
      objects: total.objects + ownership.objects,
      subscribers: 0,
      pendingUploads: 0,
    }), {
      geometries: 0,
      textures: 0,
      renderTargets: 0,
      programs: 0,
      nodes: 0,
      objects: 0,
      subscribers: 0,
      pendingUploads: 0,
    });
    return Object.freeze(resources);
  }

  snapshotEvidence(): Readonly<LogicalResourceRegistrySnapshot> {
    const resources = this.snapshot();
    const bytes = [...this.#owners.values()].reduce((total, ownership) => total + ownership.bytes, 0);
    return Object.freeze({
      initialized: this.#initialized,
      disposed: this.#disposed,
      owners: this.#owners.size,
      adopted: this.#adopted,
      released: this.#released,
      bytes,
      resources,
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = Promise.resolve().then(() => {
      if (this.#owners.size > 0) {
        throw new Error(`Logical resource registry retained ${this.#owners.size} owner(s) at disposal.`);
      }
      this.#initialized = false;
      this.#disposed = true;
    });
    return this.#disposePromise;
  }
}
