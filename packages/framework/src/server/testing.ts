import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Json } from "@sweatpants/session-contract";
import type { BoundStandardA2AHost, StandardA2AEvidence } from "./standard-a2a-host.ts";
import type { StandardA2AServedAgent } from "./agent-profiles.ts";

export interface StartAgentHarnessOptions {
  readonly agent: StandardA2AServedAgent | BoundStandardA2AHost;
  readonly hostname?: string;
  readonly port?: number;
  readonly discoveryHeaders?: Readonly<Record<string, string>>;
  readonly teardownTimeoutMs?: number;
}

export interface AgentHarness {
  readonly origin: string;
  readonly cardUrl: string;
  readonly interfaceUrl: string;
  readonly host: BoundStandardA2AHost;
  readonly discoveredCard: Json;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  evidence(
    contextId: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<StandardA2AEvidence>;
  stop(): Promise<void>;
}

/**
 * Real-loopback development harness. All certification traffic crosses TCP/HTTP;
 * direct host calls are exposed only for content-safe evidence inspection.
 */
export async function startAgentHarness(options: StartAgentHarnessOptions): Promise<AgentHarness> {
  const host = boundHost(options.agent);
  const hostname = options.hostname ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(hostname)) {
    throw new Error("Agent harness binds loopback only");
  }
  const server = createServer((request, response) => {
    void handleNodeRequest(host, request, response);
  });
  await listen(server, options.port ?? 0, hostname);
  const address = server.address() as AddressInfo;
  const origin = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  const cardUrl = `${origin}/.well-known/agent-card.json`;
  const interfaces = (host.card as Record<string, Json>)["supportedInterfaces"] as Array<
    Record<string, Json>
  >;
  const interfacePath = new URL(String(interfaces[0]!["url"])).pathname;
  const interfaceUrl = `${origin}${interfacePath}`;
  const discovery = await fetch(
    cardUrl,
    options.discoveryHeaders ? { headers: options.discoveryHeaders } : {},
  );
  if (!discovery.ok) {
    await closeServer(server, options.teardownTimeoutMs ?? 5_000);
    throw new Error(`Agent harness discovery failed with status ${discovery.status}`);
  }
  const discoveredCard = (await discovery.json()) as Json;
  let stopped = false;
  return Object.freeze({
    origin,
    cardUrl,
    interfaceUrl,
    host,
    discoveredCard,
    fetch(path: string, init?: RequestInit) {
      return fetch(new URL(path, origin), init);
    },
    async evidence(
      contextId: string,
      headers: Readonly<Record<string, string>> = options.discoveryHeaders ?? {},
    ) {
      // Evidence is deliberately not an HTTP route and therefore cannot appear in
      // production discovery. Tests authenticate it with the same transport adapter.
      const request = new Request(cardUrl, { headers });
      const context = inferredEvidenceContext(request);
      return host.evidence(contextId, context);
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await closeServer(server, options.teardownTimeoutMs ?? 5_000);
    },
  });
}

function boundHost(agent: StandardA2AServedAgent | BoundStandardA2AHost): BoundStandardA2AHost {
  const candidate = "posture" in agent ? agent.host : agent;
  if (!candidate || !("handle" in candidate) || typeof candidate.handle !== "function") {
    throw new Error("startAgentHarness requires a bound standard A2A task host");
  }
  return candidate as BoundStandardA2AHost;
}

function inferredEvidenceContext(request: Request) {
  // No production test-control endpoint is installed. A harness caller that needs
  // evidence should use explicit direct principal context through evidenceFor().
  const principal = request.headers.get("x-harness-principal");
  if (!principal) {
    throw new Error("Evidence inspection requires x-harness-principal");
  }
  return {
    principalId: principal,
    ...(request.headers.get("x-harness-tenant")
      ? { tenantId: request.headers.get("x-harness-tenant")! }
      : {}),
  };
}

async function handleNodeRequest(
  host: BoundStandardA2AHost,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    const address = incoming.socket.localAddress ?? "127.0.0.1";
    const hostHeader = incoming.headers.host ?? `${address}:${incoming.socket.localPort}`;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        value.forEach((item) => headers.append(name, item));
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const method = incoming.method ?? "GET";
    const response = await host.handle(
      new Request(`http://${hostHeader}${incoming.url ?? "/"}`, {
        method,
        headers,
        ...(!["GET", "HEAD"].includes(method) && body.byteLength > 0 ? { body } : {}),
      }),
    );
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) {
      outgoing.statusCode = 500;
    }
    outgoing.end(
      '{"error":{"code":"harness_transport_error","message":"Harness transport failed"}}',
    );
  }
}
function listen(server: Server, port: number, hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
async function closeServer(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Agent harness teardown timed out")), timeoutMs),
    ),
  ]);
}
