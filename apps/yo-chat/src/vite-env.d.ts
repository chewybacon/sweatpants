/// <reference types="vite/client" />

import type { Worker, WorkerOptions } from "node:worker_threads";

// Declaration for vite-plugin-node-worker imports
// ?modulePath returns a URL to the bundled worker script
declare module "*?modulePath" {
  const url: URL;
  export default url;
}

// ?nodeWorker returns a factory function that creates a Worker
declare module "*?nodeWorker" {
  export default function createWorker(options?: WorkerOptions): Worker;
}

// Declaration for vite-imagetools imports with query parameters
declare module "*?format=webp&inline" {
  const src: string;
  export default src;
}

declare module "*?inline" {
  const src: string;
  export default src;
}

declare module "*?format=webp" {
  const src: string;
  export default src;
}
