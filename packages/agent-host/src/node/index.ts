export { openChatStorageDatabase } from "@sweatpants/durable-chat-runtime/node-storage";
import { serve as serveNode, toNodeHandler as adaptNode } from "srvx/node";
import type { ServerOptions, NodeHttp1Handler, FetchHandler } from "srvx";

/** Advanced mounting on an existing Node server; application lifetime stays with the caller. */
export function toNodeHandler(
  handler: FetchHandler,
  options?: Parameters<typeof adaptNode>[1],
): NodeHttp1Handler {
  // srvx handles both HTTP versions; this entry is for node:http's request listener.
  return adaptNode(handler, options) as NodeHttp1Handler;
}

export interface HttpApplication {
  handler(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export type ServeOptions = Pick<ServerOptions, "hostname" | "port" | "tls" | "middleware">;

export interface ApplicationServer {
  readonly origin: string;
  /** Stops ingress, cancels open connections, and awaits application cleanup. */
  close(): Promise<void>;
}

/** Serve a Fetch application using srvx's backpressured Web-stream transport. */
export async function serve(
  app: HttpApplication,
  options: ServeOptions = {},
): Promise<ApplicationServer> {
  try {
    const server = serveNode({
      hostname: "127.0.0.1",
      ...options,
      fetch: app.handler,
      silent: true,
      gracefulShutdown: false,
    });
    await server.ready();
    let closing: Promise<void> | undefined;
    return {
      origin: new URL(server.url!).origin,
      close() {
        return (closing ??= Promise.all([server.close(true), app.close()]).then(() => {}));
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}
