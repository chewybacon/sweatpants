import { writeFile } from "node:fs/promises";
import type { Profiler } from "node:inspector";
import type { Miniflare } from "miniflare";

/** Test-only workerd sampling. Never profiles the Node test runner. */
export async function startWorkerCpuProfile(worker: Miniflare, path: string) {
  const inspector = await worker.getInspectorURL();
  inspector.protocol = "http:";
  const response = await fetch(new URL("/json/list", inspector));
  if (!response.ok) {
    throw new Error(`Inspector discovery failed: ${response.status}`);
  }
  const targets = (await response.json()) as Array<{ title: string; webSocketDebuggerUrl: string }>;
  const target = targets.find(({ title }) => title.includes("yo-chat-host"));
  if (!target) {
    throw new Error("yo-chat-host inspector target missing");
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener("close", () => rejectPending(new Error("Inspector closed")));
  socket.addEventListener("error", () => rejectPending(new Error("Inspector connection failed")));
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) {
      return;
    }
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      request?.reject(new Error(message.error.message));
    } else {
      request?.resolve(message.result);
    }
  });
  async function send(method: string, params = {}): Promise<unknown> {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.get(id)?.reject(new Error(`Inspector timed out: ${method}`));
      pending.delete(id);
    }, 5000);
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Inspector connection timed out")), 5000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Inspector connection failed"));
        },
        { once: true },
      );
    });
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", { interval: 100 });
    await send("Profiler.start");
  } catch (error) {
    socket.close();
    throw error;
  }
  return async () => {
    try {
      const { profile } = (await send("Profiler.stop")) as { profile: Profiler.Profile };
      await writeFile(path, JSON.stringify(profile));
    } finally {
      socket.close();
    }
  };
}
