import { createChunkWorkerEndpoint } from "../gfx/v2/chunks/worker-endpoint";

interface WorkerScopePort {
  addEventListener(
    type: "message" | "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
}

const scope = self as unknown as WorkerScopePort;
const endpoint = createChunkWorkerEndpoint((reply, transfer) => {
  scope.postMessage(reply, transfer);
});

scope.addEventListener("message", (event) => endpoint.receive(event.data));
scope.addEventListener("messageerror", () => endpoint.receive(Object.freeze({
  kind: "messageerror",
  protocolVersion: "invalid",
})));
