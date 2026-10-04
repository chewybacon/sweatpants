import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { createScope, ensure, useScope, type Operation } from "effection";
import { z } from "zod";
import type { AnyToolContract } from "@sweatpants/agent-sdk";
import type { Json } from "@sweatpants/foundation";
import {
  ToolInvocationHostPort,
  ToolInvocationEventSourcePort,
  ToolInvocationHostError,
  type ToolInvocationTurn,
  type ToolInvocationResume,
} from "../../invocation.ts";
import { createMcpContinuations, McpContinuationError } from "../continuations.ts";
import {
  readMcpRequestMetadata,
  requireMcpFormCapability,
  McpRequestMetadataError,
  compileMcpParameterHeaders,
  validateMcpParameterHeaders,
} from "../request-metadata.ts";
import { MCP_PROTOCOL_VERSION } from "../protocol-version.ts";
import { encodeLogNotification, encodeProgressNotification } from "../protocol/message-encoder.ts";
import {
  McpHttpError as HttpError,
  requestEnvelope,
  readMcpBody,
  acceptsMcpResponses,
} from "./http.ts";
import {
  projectInputRequest,
  resumeInput,
  requireInputCapabilities,
  type McpFormAdapters,
} from "./interactions.ts";
import { projectMcpTool } from "./manifest.ts";

const logLevels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

export type McpHttpHandler = (request: Request) => Promise<Response>;
export interface McpHandlerOptions {
  name: string;
  version: string;
  secret: string;
  tools: readonly AnyToolContract[];
  /** Trusted application identity, never self-reported MCP clientInfo. */
  authenticate(request: Request): Operation<string>;
  /** Same-origin requests are accepted by default. */
  allowedOrigins?: readonly string[];
  forms?: McpFormAdapters;
}
function failure(error: unknown, id: string | number | null) {
  const known = error instanceof HttpError || error instanceof McpRequestMetadataError;
  const stateError =
    error instanceof McpContinuationError || error instanceof ToolInvocationHostError;
  return {
    status: known ? error.status : stateError ? 400 : 500,
    body: {
      jsonrpc: "2.0",
      id,
      error: {
        code: known ? error.code : stateError ? -32602 : -32603,
        message: known || stateError ? error.message : "Internal server error",
        ...(error instanceof McpRequestMetadataError && error.data ? { data: error.data } : {}),
      },
    },
  };
}

/** POST-only MCP. Runtime placement and execution lifetime remain application-owned. */
export function* createMcpHandler(
  options: McpHandlerOptions,
): Operation<{ handler: McpHttpHandler }> {
  const installation = yield* useScope();
  // SCOPE-CROSSING (ownership): HTTP request scopes dispatch into the application-owned invocation runtime.
  const host = ToolInvocationHostPort.bind(installation);
  // SCOPE-CROSSING (ownership): HTTP response readers consume the application's invocation projections.
  const events = ToolInvocationEventSourcePort.bind(installation);
  const continuations = createMcpContinuations({ secret: options.secret });
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  if (tools.size !== options.tools.length) throw new Error("Duplicate MCP tool name");
  const parameterHeaders = new Map(
    [...tools].map(([name, tool]) => [
      name,
      compileMcpParameterHeaders(tool.artifacts.parameters.inputProjection),
    ]),
  );
  const invocations = new Set<string>();
  yield* ensure(function* () {
    for (const id of invocations) yield* host.dispose(id);
  });
  const serverMeta = {
    "io.modelcontextprotocol/serverInfo": { name: options.name, version: options.version },
  };
  const cache = { ttlMs: 0, cacheScope: "private" };

  const handler: McpHttpHandler = async (request) => {
    const [scope, destroy] = createScope(installation);
    // Request failures must not escape into the supervising application task.
    async function run<T>(operation: () => Operation<T>): Promise<T> {
      const result = await scope.run(function* () {
        try {
          return { ok: true as const, value: yield* operation() };
        } catch (error) {
          return { ok: false as const, error };
        }
      });
      if (!result.ok) throw result.error;
      return result.value;
    }
    let id: string | number | null = null;
    let streaming = false;
    try {
      const origin = request.headers.get("origin");
      if (
        origin &&
        origin !== new URL(request.url).origin &&
        !options.allowedOrigins?.includes(origin)
      )
        throw new HttpError(403, -32600, "Origin is not allowed");
      if (request.method !== "POST") throw new HttpError(405, -32600, "MCP requires POST");
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        throw new HttpError(415, -32600, "Content-Type must be application/json");
      const accept = request.headers.get("accept") ?? "";
      if (!acceptsMcpResponses(accept))
        throw new HttpError(
          406,
          -32600,
          "Accept must include application/json and text/event-stream",
        );
      const parsed = requestEnvelope.safeParse(await readMcpBody(request));
      if (!parsed.success)
        throw new HttpError(400, -32600, "Expected a JSON-RPC request with params");
      const rpc = parsed.data;
      id = rpc.id;
      const metadata = readMcpRequestMetadata({
        ...rpc,
        headers: request.headers,
        protocolVersion: MCP_PROTOCOL_VERSION,
      });
      const callerId = await run(() => options.authenticate(request));
      if (!callerId) throw new HttpError(401, -32600, "Caller identity is required");
      const success = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
      if (rpc.method === "server/discover")
        return success({
          resultType: "complete",
          ...cache,
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          _meta: serverMeta,
        });
      if (rpc.method === "tools/list")
        return success({
          resultType: "complete",
          ...cache,
          tools: [...tools].map(([name, tool]) => projectMcpTool(name, tool)),
        });
      if (rpc.method !== "tools/call") throw new HttpError(404, -32601, "Method not found");
      const {
        name,
        arguments: args = {},
        requestState,
        inputResponses,
        _meta,
        ...extra
      } = rpc.params;
      if (typeof name !== "string" || !tools.has(name))
        throw new HttpError(400, -32602, "Unknown tool");
      const tool = tools.get(name)!;
      const forms = options.forms?.[name];
      validateMcpParameterHeaders(request.headers, args, parameterHeaders.get(name)!);
      if (tool.capabilities.elicitation) requireMcpFormCapability(metadata.capabilities);
      if (
        tool.capabilities.sampling &&
        !z.object({}).safeParse(metadata.capabilities.sampling).success
      )
        throw new McpRequestMetadataError(-32021, "Client does not support sampling", {
          requiredCapabilities: { sampling: {} },
        });
      if (validateAuthoredSchema(tool.parameters, args).status !== "ok")
        throw new HttpError(400, -32602, "Arguments do not match the authored tool schema");
      const binding = {
        serverId: options.name,
        callerId,
        method: rpc.method,
        params: { name, arguments: args, ...extra } as Json,
      };
      let invocationId: string;
      let cursor = 0;
      let resume: ToolInvocationResume | undefined;
      if (requestState !== undefined) {
        if (typeof requestState !== "string")
          throw new HttpError(400, -32602, "Invalid requestState");
        const reference = await run(() => continuations.verify(requestState, binding));
        invocationId = reference.invocationId;
        cursor = Number(reference.pullId);
        if (!Number.isSafeInteger(cursor) || cursor < 1)
          throw new HttpError(400, -32602, "Invalid continuation cursor");
        const parked = await run(() =>
          host.turn({ invocationId, commandId: `mcp:inspect:${cursor}`, cursor: cursor - 1 }),
        );
        if (parked.type !== "parked" || parked.cursor !== cursor)
          throw new HttpError(400, -32602, "Pending input is unavailable");
        requireInputCapabilities(parked.ask, metadata.capabilities);
        resume = resumeInput(parked.ask, inputResponses, forms);
        if (
          parked.ask.kind === "elicit" &&
          resume.kind === "elicit" &&
          resume.response.action === "accept"
        ) {
          const validation = validateAuthoredSchema(
            tool.elicits[parked.ask.key]?.response,
            resume.response.content,
          );
          if (validation.status !== "ok")
            throw new HttpError(
              400,
              -32602,
              "Input does not match the authored elicitation schema",
            );
        }
      } else {
        if (inputResponses !== undefined)
          throw new HttpError(400, -32602, "inputResponses requires requestState");
        invocationId = crypto.randomUUID();
        await run(() => host.start({ invocationId, tool, input: args }));
        invocations.add(invocationId);
      }
      const reader = await run(() => events.open(invocationId));
      if (!reader) throw new HttpError(400, -32602, "Invocation is unavailable");
      // The host deduplicates retries by command identity and rejects changed answers.
      const outcome = run(() =>
        host.turn({ invocationId, commandId: `mcp:turn:${cursor}`, cursor, resume }),
      ).then(
        (turn) => ({ turn }),
        (error) => ({ error }),
      );
      const turnFailure = outcome.then((result) =>
        "error" in result ? { error: result.error } : new Promise<never>(() => {}),
      );
      let finished = false;
      const encoder = new TextEncoder();
      const serialize = (message: unknown) =>
        encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      async function resultFor(turn: ToolInvocationTurn): Promise<unknown> {
        if (turn.type === "parked") {
          const ask = turn.ask;
          requireInputCapabilities(ask, metadata.capabilities);
          const inputRequest = projectInputRequest(ask, forms);
          return {
            resultType: "input_required",
            inputRequests: { [ask.requestId]: inputRequest },
            requestState: await run(() =>
              continuations.issue(binding, { invocationId, pullId: String(turn.cursor) }),
            ),
          };
        }
        return {
          resultType: "complete",
          isError: turn.type !== "completed",
          content: [
            {
              type: "text",
              text:
                turn.type === "completed"
                  ? typeof turn.result === "string"
                    ? turn.result
                    : JSON.stringify(turn.result)
                  : turn.type === "failed"
                    ? turn.error.message
                    : (turn.reason ?? "Cancelled"),
            },
          ],
        };
      }
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              // Pull exactly one projection record at a time. No background notification queue.
              while (!finished) {
                const settled = await Promise.race([
                  run(function* () {
                    const subscription = yield* reader.events(cursor);
                    return { event: yield* subscription.next() };
                  }),
                  turnFailure,
                ]);
                if ("error" in settled) throw settled.error;
                const next = settled.event;
                if (next.done) throw new Error("Invocation ended without a result");
                cursor = next.value.lsn;
                const event = next.value;
                const progressToken = z
                  .object({ progressToken: z.union([z.string(), z.number()]).optional() })
                  .safeParse(_meta);
                if (
                  event.type === "progress" &&
                  progressToken.success &&
                  progressToken.data.progressToken !== undefined
                ) {
                  controller.enqueue(
                    serialize(encodeProgressNotification(event, progressToken.data.progressToken)),
                  );
                  return;
                }
                if (
                  event.type === "log" &&
                  metadata.logLevel &&
                  logLevels.indexOf(event.level) >= logLevels.indexOf(metadata.logLevel)
                ) {
                  controller.enqueue(serialize(encodeLogNotification(event)));
                  return;
                }
                if (
                  event.type === "log" ||
                  event.type === "progress" ||
                  event.type === "sample_response_queued"
                )
                  continue;
                const result = await outcome;
                if ("error" in result) throw result.error;
                controller.enqueue(
                  serialize({ jsonrpc: "2.0", id, result: await resultFor(result.turn) }),
                );
                finished = true;
                controller.close();
                await destroy();
              }
            } catch (error) {
              finished = true;
              controller.enqueue(serialize(failure(error, id).body));
              controller.close();
              await destroy();
            }
          },
          async cancel() {
            if (finished) return;
            finished = true;
            await destroy();
            await installation.run(() => host.dispose(invocationId));
            invocations.delete(invocationId);
          },
        },
        { highWaterMark: 0 },
      );
      streaming = true;
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      });
    } catch (error) {
      const result = failure(error, id);
      return Response.json(result.body, { status: result.status });
    } finally {
      if (!streaming) await destroy();
    }
  };
  return { handler };
}
