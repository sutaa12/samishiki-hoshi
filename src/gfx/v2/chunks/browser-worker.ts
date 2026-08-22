/// <reference types="vite/client" />

import type { ChunkWorkerPort } from "./contracts";
import { ChunkWorkerClient } from "./worker-client";
import WorldChunkWorker from "../../../workers/world-chunk-worker?worker";

export function createBrowserWorldChunkWorker(): ChunkWorkerClient {
  if (typeof Worker !== "function") {
    throw new Error("A browser Worker implementation is required for world chunk generation.");
  }
  const worker = new WorldChunkWorker({
    name: "lonely-star-world-chunks",
  });
  try {
    return new ChunkWorkerClient(worker as unknown as ChunkWorkerPort);
  } catch {
    worker.terminate();
    throw new Error("World chunk worker client construction failed.");
  }
}
