import type { ResponseStreamRig } from "./contracts.ts";

/** A real in-process readable stream for scripted host/client journeys; no sockets or wire codec. */
export function createResponseStreamRig<T>(): ResponseStreamRig<T> {
  let controller!: ReadableStreamDefaultController<T>;
  let closed = false;
  const stream = new ReadableStream<T>({
    start(value) {
      controller = value;
    },
  });
  const reader = stream.getReader();
  return {
    publish(frame) {
      if (closed) {
        throw new Error("Response stream disconnected");
      }
      controller.enqueue(structuredClone(frame));
    },
    read: () => reader.read(),
    disconnect() {
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
  };
}
