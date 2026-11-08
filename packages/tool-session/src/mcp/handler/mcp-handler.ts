import { validateToolAnswer } from "@sweatpants/agent-sdk";
import { toolImplementation } from "@sweatpants/agent-sdk/internal/tool-execution";
import type { Middleware } from "@sweatpants/standard-durability";
import type { EffectionYield } from "@sweatpants/standard-durability-effection";
import type { ToolEffectSignature } from "@sweatpants/agent-sdk";
import { effection } from "@sweatpants/standard-durability-effection";
import { createToolEffects } from "@sweatpants/agent-sdk";
import { type ToolDefinition, type JournalRequest } from "@sweatpants/agent-sdk";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { call, createScope, ensure, useScope, type Operation } from "effection";
import { z } from "zod";
import { assertJson, requireJsonObject, type Json } from "@sweatpants/foundation";
import type {
  Identity,
  PendingJournal,
  Activation,
  RequestOccurrence,
} from "@sweatpants/foundation/journal";
import { activateJournal, createIteratorGuest } from "@sweatpants/primitive-journal";
import type { ToolInvocationAsk } from "../../invocation.ts";
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

type McpActivation = Activation<Json> | { state: "failed"; reason: string };

const logLevels = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

export type McpHttpHandler = (request: Request) => Promise<Response>;
export interface McpHandlerOptions {
  name: string;
  version: string;
  secret: string;
  tools: readonly ToolDefinition[];
  createJournal(
    identity: Identity,
  ): PendingJournal & { close(): void; settle(status: "failed", reason: string): void };
  /** Runs in array order inside declaration validation; receives canonical input, returns raw output. */
  effectMiddleware?: readonly Middleware<ToolEffectSignature, EffectionYield>[];
  effects?: Readonly<Record<string, (input: Json) => Operation<Json>>>;
  /** Trusted application identity, never self-reported MCP clientInfo. */
  authenticate(request: Request): Operation<string>;
  /** Same-origin requests are accepted by default. */
  allowedOrigins?: readonly string[];
  forms?: McpFormAdapters;
}
function failure(error: unknown, id: string | number | null) {
  const known = error instanceof HttpError || error instanceof McpRequestMetadataError;
  const stateError = error instanceof McpContinuationError;
  return {
    status: known ? error.status : stateError ? 400 : 500,
    body: {
      jsonrpc: "2.0",
      id,
      error: {
        code: known ? error.code : stateError ? -32602 : -32603,
        message: known || stateError ? error.message : "Internal server error",
        /* CONDITIONAL-SPREAD: Omit absent data from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
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
  const continuations = createMcpContinuations({ secret: options.secret });
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  if (tools.size !== options.tools.length) {
    throw new Error("Duplicate MCP tool name");
  }
  const parameterHeaders = new Map(
    [...tools].map(([name, tool]) => [
      name,
      compileMcpParameterHeaders(tool.artifacts.parameters.inputProjection),
    ]),
  );
  // One journal and native lifetime per invocation. Reply tasks only bind a protocol
  // retry to its original activation; accepted answers live in the journal.
  const invocations = new Map<
    string,
    {
      journal: ReturnType<McpHandlerOptions["createJournal"]>;
      scope: ReturnType<typeof createScope>[0];
      dispose(): Promise<void>;
      replies: Map<string, Promise<McpActivation>>;
      listeners: Set<() => void>;
    }
  >();
  yield* ensure(function* () {
    for (const invocation of invocations.values()) {
      yield* call(invocation.dispose);
    }
    invocations.clear();
  });
  function askFor(tool: ToolDefinition, occurrence: RequestOccurrence): ToolInvocationAsk {
    const request = occurrence.request as JournalRequest;
    if (request.kind === "nested-sample") {
      return {
        kind: "sample",
        requestId: occurrence.id,
        messages: [{ role: "user", content: request.prompt }],
        maxTokens: request.maxTokens,
        // CONDITIONAL-SPREAD: absent schema must not advertise structured sampling.
        ...(request.schema ? { schema: request.schema } : {}),
      };
    }
    if (request.kind !== "elicit") {
      throw new HttpError(400, -32602, "Invalid pending input");
    }
    return {
      kind: "elicit",
      requestId: occurrence.id,
      key: request.key,
      message: request.message,
      // CONDITIONAL-SPREAD: absent authored context must not add an MCP form extension.
      ...(request.context === null ? {} : { context: request.context }),
      schema: requireJsonObject(tool.artifacts.elicits[request.key]!.response.inputProjection),
      binding: tool.bindings.elicits[request.key]!,
    };
  }
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
      if (!result.ok) {
        throw result.error;
      }
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
      ) {
        throw new HttpError(403, -32600, "Origin is not allowed");
      }
      if (request.method !== "POST") {
        throw new HttpError(405, -32600, "MCP requires POST");
      }
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
        throw new HttpError(415, -32600, "Content-Type must be application/json");
      }
      const accept = request.headers.get("accept") ?? "";
      if (!acceptsMcpResponses(accept)) {
        throw new HttpError(
          406,
          -32600,
          "Accept must include application/json and text/event-stream",
        );
      }
      const parsed = requestEnvelope.safeParse(await readMcpBody(request));
      if (!parsed.success) {
        throw new HttpError(400, -32600, "Expected a JSON-RPC request with params");
      }
      const rpc = parsed.data;
      id = rpc.id;
      const metadata = readMcpRequestMetadata({
        ...rpc,
        headers: request.headers,
        protocolVersion: MCP_PROTOCOL_VERSION,
      });
      const callerId = await run(() => options.authenticate(request));
      if (!callerId) {
        throw new HttpError(401, -32600, "Caller identity is required");
      }
      const success = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
      if (rpc.method === "server/discover") {
        return success({
          resultType: "complete",
          ...cache,
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          _meta: serverMeta,
        });
      }
      if (rpc.method === "tools/list") {
        return success({
          resultType: "complete",
          ...cache,
          tools: [...tools].map(([name, tool]) => projectMcpTool(name, tool)),
        });
      }
      if (rpc.method !== "tools/call") {
        throw new HttpError(404, -32601, "Method not found");
      }
      const {
        name,
        arguments: args = {},
        requestState,
        inputResponses,
        _meta,
        ...extra
      } = rpc.params;
      if (typeof name !== "string" || !tools.has(name)) {
        throw new HttpError(400, -32602, "Unknown tool");
      }
      const tool = tools.get(name)!;
      const forms = options.forms?.[name];
      validateMcpParameterHeaders(request.headers, args, parameterHeaders.get(name)!);
      if (tool.capabilities.elicitation) {
        requireMcpFormCapability(metadata.capabilities);
      }
      if (
        tool.capabilities.sampling &&
        !z.object({}).safeParse(metadata.capabilities.sampling).success
      ) {
        throw new McpRequestMetadataError(-32021, "Client does not support sampling", {
          requiredCapabilities: { sampling: {} },
        });
      }
      if (validateAuthoredSchema(tool.parameters, args).status !== "ok") {
        throw new HttpError(400, -32602, "Arguments do not match the authored tool schema");
      }
      const binding = {
        serverId: options.name,
        callerId,
        method: rpc.method,
        params: { name, arguments: args, ...extra } as Json,
      };
      let invocationId: string;
      let replyId = "initial";
      let sequence = 0;
      if (requestState !== undefined) {
        if (typeof requestState !== "string") {
          throw new HttpError(400, -32602, "Invalid requestState");
        }
        const reference = await run(() => continuations.verify(requestState, binding));
        invocationId = reference.invocationId;
        replyId = reference.pullId;
        const invocation = invocations.get(invocationId);
        const occurrence = invocation?.journal.readRequests().find((item) => item.id === replyId);
        if (!invocation || !occurrence) {
          throw new HttpError(400, -32602, "Pending input is unavailable");
        }
        const ask = askFor(tool, occurrence);
        requireInputCapabilities(ask, metadata.capabilities);
        const resume = resumeInput(ask, inputResponses, forms);
        if (resume.kind === "cancel") {
          throw new HttpError(400, -32602, "Invalid input response");
        }
        if (ask.kind === "elicit" && resume.kind === "elicit") {
          try {
            validateToolAnswer(tool, ask.key, resume.response);
          } catch {
            throw new HttpError(
              400,
              -32602,
              "Input does not match the authored elicitation schema",
            );
          }
        }
        const value = resume.response;
        try {
          invocation.journal.acceptRequest(replyId, { ok: true, value: assertJson(value) });
        } catch (error) {
          throw new HttpError(
            400,
            -32602,
            error instanceof Error ? error.message : "Invalid answer",
          );
        }
        sequence = occurrence.sequence + 1;
      } else {
        if (inputResponses !== undefined) {
          throw new HttpError(400, -32602, "inputResponses requires requestState");
        }
        invocationId = crypto.randomUUID();
        const journal = options.createJournal({
          executionId: invocationId,
          program: { id: tool.name, version: tool.version ?? "1", digest: tool.interfaceDigest },
          input: assertJson(args),
        });
        const [owner, dispose] = createScope(installation);
        let closing: Promise<void> | undefined;
        invocations.set(invocationId, {
          journal,
          scope: owner,
          dispose() {
            return (closing ??= dispose().finally(() => {
              journal.close();
              invocations.delete(invocationId);
            }));
          },
          replies: new Map(),
          listeners: new Set(),
        });
      }
      const invocation = invocations.get(invocationId)!;
      const wake = () => {
        for (const listener of invocation.listeners) {
          listener();
        }
      };
      let activation = invocation.replies.get(replyId);
      if (!activation) {
        activation = invocation.scope
          .run(function* () {
            const Effects = createToolEffects(effection);
            // Catch inside the owner so a tool failure cannot tear down the app.
            try {
              return {
                ok: true as const,
                value: yield* Effects.withEffects(
                  [tool],
                  {
                    *effect(request) {
                      return {
                        ok: true,
                        value: yield* options.effects![`${request.tool}.${request.key}`]!(
                          request.input,
                        ),
                      };
                    },
                  },
                  function* () {
                    return yield* activateJournal(
                      function* () {
                        return createIteratorGuest(() =>
                          toolImplementation(tool).invoke(args, invocationId),
                        );
                      },
                      invocation.journal,
                      {
                        classify(effectRequest) {
                          return effectRequest.kind === "elicit" ||
                            effectRequest.kind === "nested-sample"
                            ? "park"
                            : effectRequest.kind === "effect"
                              ? effectRequest.retrySafety.mode
                              : "repeatable";
                        },
                        *handler(effectRequest) {
                          if (effectRequest.kind !== "effect") {
                            return { ok: true as const, value: null };
                          }
                          const effect =
                            options.effects?.[`${effectRequest.tool}.${effectRequest.key}`];
                          if (!effect) {
                            throw new Error(
                              `Missing MCP effect: ${effectRequest.tool}.${effectRequest.key}`,
                            );
                          }
                          try {
                            return yield* Effects.operations.effect(effectRequest);
                          } catch (error) {
                            return {
                              ok: false as const,
                              error: error instanceof Error ? error.message : String(error),
                            };
                          }
                        },
                        accepted: wake,
                      },
                    );
                  },
                  options.effectMiddleware,
                ),
              };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              try {
                invocation.journal.settle("failed", reason);
                return { ok: true as const, value: { state: "failed" as const, reason } };
              } catch (settlementError) {
                return { ok: false as const, error: settlementError };
              }
            }
          })
          .then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            return result.value;
          });
        invocation.replies.set(replyId, activation);
      }
      const outcome = activation.then(
        (turn) => ({ turn }),
        (error: unknown) => ({ error }),
      );
      let settled: Awaited<typeof outcome> | undefined;
      void outcome.then((result) => {
        settled = result;
        wake();
        return result;
      });
      let responseBoundary = false;
      let finished = false;
      let stopWaiting: (() => void) | undefined;
      const encoder = new TextEncoder();
      const serialize = (message: unknown) =>
        encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      async function resultFor(turn: McpActivation): Promise<unknown> {
        if (turn.state === "parked") {
          const ask = askFor(tool, turn.request);
          requireInputCapabilities(ask, metadata.capabilities);
          return {
            resultType: "input_required",
            inputRequests: { [ask.requestId]: projectInputRequest(ask, forms) },
            requestState: await run(() =>
              continuations.issue(binding, { invocationId, pullId: ask.requestId }),
            ),
          };
        }
        if (turn.state === "failed") {
          return {
            resultType: "complete",
            isError: true,
            content: [{ type: "text", text: turn.reason }],
          };
        }
        return {
          resultType: "complete",
          isError: false,
          content: [
            {
              type: "text",
              text: typeof turn.value === "string" ? turn.value : JSON.stringify(turn.value),
            },
          ],
        };
      }
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              // Native activation/recording is independent of HTTP demand. Only response
              // consumption is reader-paced: inspect one exchange, stop at each deliverable
              // notification, and never prefetch the next one or load a replay snapshot.
              while (!finished) {
                while (!responseBoundary) {
                  const entry = invocation.journal.readAccepted(sequence);
                  if (!entry) {
                    break;
                  }
                  const event = entry.request as JournalRequest;
                  // An accepted historical input still ends this reply's notification window.
                  if (event.kind === "elicit" || event.kind === "nested-sample") {
                    responseBoundary = true;
                    break;
                  }
                  sequence++;
                  const progressToken = z
                    .object({ progressToken: z.union([z.string(), z.number()]).optional() })
                    .safeParse(_meta);
                  if (
                    event.kind === "progress" &&
                    progressToken.success &&
                    progressToken.data.progressToken !== undefined
                  ) {
                    controller.enqueue(
                      serialize(
                        encodeProgressNotification(event, progressToken.data.progressToken),
                      ),
                    );
                    return;
                  }
                  if (
                    event.kind === "log" &&
                    metadata.logLevel &&
                    logLevels.indexOf(event.level) >= logLevels.indexOf(metadata.logLevel)
                  ) {
                    controller.enqueue(serialize(encodeLogNotification(event)));
                    return;
                  }
                }
                if (!settled) {
                  await new Promise<void>((resolve) => {
                    const listener = () => {
                      invocation.listeners.delete(listener);
                      stopWaiting = undefined;
                      resolve();
                    };
                    stopWaiting = listener;
                    invocation.listeners.add(listener);
                    // No asynchronous gap between journal read and listener registration.
                  });
                  continue;
                }
                if ("error" in settled) {
                  throw settled.error;
                }
                const result = await resultFor(settled.turn);
                if (finished) {
                  return;
                }
                controller.enqueue(serialize({ jsonrpc: "2.0", id, result }));
                finished = true;
                controller.close();
                await destroy();
              }
            } catch (error) {
              if (finished) {
                return;
              }
              finished = true;
              controller.enqueue(serialize(failure(error, id).body));
              controller.close();
              await destroy();
            }
          },
          async cancel() {
            if (finished) {
              return;
            }
            finished = true;
            stopWaiting?.();
            await destroy();
            await invocation.dispose();
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
      if (!streaming) {
        await destroy();
      }
    }
  };
  return { handler };
}
