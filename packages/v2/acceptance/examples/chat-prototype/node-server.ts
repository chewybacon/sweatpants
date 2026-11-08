import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
interface Application {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export function createNodeServer(app: Application) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>yo-chat v2</title><link rel="stylesheet" href="/client.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>`;
  const server = createServer(async (req, res) => {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      if (req.headers.host !== `localhost:${port}` && req.headers.host !== `127.0.0.1:${port}`) {
        res.writeHead(403).end();
        return;
      }
      const path = req.url ?? "/";
      if (path === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(html);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 65536) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers.set(key, value);
        }
      }
      const response = await app.fetch(
        new Request(`http://${req.headers.host}${path}`, {
          method: req.method,
          headers,
          body: req.method === "POST" ? Buffer.concat(chunks).toString("utf8") : undefined,
        }),
      );
      if (res.destroyed) {
        await response.body?.cancel();
        return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.flushHeaders();
      if (response.body) {
        // Backpressure belongs to this reader. Socket closure cancels/joins the
        // web subscription, never the application's independent model task.
        // Node and DOM declarations disagree about BYOB ArrayBuffer generics;
        // this is the same native WHATWG stream, consumed through its default reader.
        await pipeline(
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
          res,
        );
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500).end("Request failed");
      } else {
        res.destroy();
      }
    }
  });
  return server;
}
/** Stop accepting connections, release active sockets, then join application work.
 * Physical shutdown deliberately does not resolve uncertain journal attempts. */
export async function closeNodeServer(server: Server, app: Application) {
  const stopped = server.listening
    ? new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      })
    : Promise.resolve();
  server.closeAllConnections();
  await Promise.all([stopped, app.close()]);
}
