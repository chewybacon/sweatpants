import { call, type Operation } from "effection";
import { CrankError, canonicalJson, sha256, type Json } from "@sweatpants/session-contract";
import { A2A_EXTENSIONS_HEADER } from "./types.ts";
import {
  createSecureA2AHttpClient,
  parseA2AJsonResponse,
  type A2AHttpClient,
} from "./http-client.ts";
import type { A2AUrlPolicy } from "./url-policy.ts";
import {
  parseForeignA2ASendResult,
  parseForeignA2ATask,
  type ForeignA2AValidationLimits,
} from "./foreign-validation.ts";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  type ForeignA2ACancelResult,
  type ForeignA2AContinueRequest,
  type ForeignA2AInvocationPin,
  type ForeignA2AMessage,
  type ForeignA2ASendResult,
  type ForeignA2AStartRequest,
  type ForeignA2ATask,
} from "./foreign-task-types.ts";

export class ForeignA2ATransportError extends CrankError {
  constructor(
    code: string,
    message: string,
    readonly acceptanceUnknown: boolean,
    options?: { cause?: unknown },
  ) {
    super(code, message, undefined, options);
    this.name = "ForeignA2ATransportError";
  }
}

export type ResolveForeignInvocationResult =
  | { readonly status: "not_found" }
  | { readonly status: "bound"; readonly result: ForeignA2ASendResult }
  | { readonly status: "aborted"; readonly expiresAt: string };
export type AbortForeignInvocationResult =
  | { readonly status: "bound"; readonly result: ForeignA2ASendResult }
  | { readonly status: "aborted"; readonly expiresAt: string };

export interface ForeignA2AClientPort {
  sendInitial(request: ForeignA2AStartRequest): Operation<ForeignA2ASendResult>;
  sendContinuation(request: ForeignA2AContinueRequest): Operation<ForeignA2ASendResult>;
  getTask(request: {
    pin: ForeignA2AInvocationPin;
    taskId: string;
    historyLength?: number;
  }): Operation<ForeignA2ATask>;
  cancelTask(request: { pin: ForeignA2AInvocationPin; taskId: string }): Operation<ForeignA2ATask>;
  resolveInvocation?(request: {
    pin: ForeignA2AInvocationPin;
    messageDigest: string;
  }): Operation<ResolveForeignInvocationResult>;
  abortInvocation?(request: {
    pin: ForeignA2AInvocationPin;
    messageDigest: string;
  }): Operation<AbortForeignInvocationResult>;
  subscribeTask?(request: {
    pin: ForeignA2AInvocationPin;
    taskId: string;
  }): Operation<AsyncIterable<ForeignA2ATask>>;
}

export interface ForeignA2AHttpTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Json;
}
export interface ForeignA2AHttpTransport {
  request(input: {
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Json;
    readonly principalId: string;
    readonly tenantId?: string;
  }): Promise<ForeignA2AHttpTransportResponse>;
}

export interface HttpJsonForeignA2AClientOptions {
  readonly transport: ForeignA2AHttpTransport;
  readonly validationLimits?: Partial<ForeignA2AValidationLimits>;
}
export interface SecureForeignA2AHttpTransportOptions {
  readonly cardOrigin: string;
  readonly urlPolicy?: A2AUrlPolicy;
  readonly httpClient?: A2AHttpClient;
  readonly authorization?: (
    url: URL,
    principalId: string,
    tenantId?: string,
  ) =>
    | Promise<Readonly<Record<string, string>> | undefined>
    | Readonly<Record<string, string>>
    | undefined;
}

/** HTTPS transport that applies the shared SSRF, redirect, and DNS-pinning policy to every operation. */
export function createSecureForeignA2AHttpTransport(
  options: SecureForeignA2AHttpTransportOptions,
): ForeignA2AHttpTransport {
  const http = options.httpClient ?? createSecureA2AHttpClient();
  return {
    async request(input) {
      const response = await http.request({
        url: input.url,
        purpose: "manifest",
        method: input.method,
        ...(input.body !== undefined ? { body: input.body } : {}),
        headers: input.headers,
        cardOrigin: options.cardOrigin,
        ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
        ...(options.authorization
          ? {
              authorization: async (url) => ({
                headers:
                  (await options.authorization!(url, input.principalId, input.tenantId)) ?? {},
              }),
            }
          : {}),
      });
      return {
        status: response.status,
        headers: response.headers,
        ...(response.body.byteLength > 0 ? { body: parseA2AJsonResponse(response) } : {}),
      };
    },
  };
}

/** Binding-neutral semantics projected onto the A2A HTTP+JSON v1 binding. */
export function createHttpJsonForeignA2AClient(
  options: HttpJsonForeignA2AClientOptions,
): ForeignA2AClientPort {
  return {
    *sendInitial(request) {
      assertNotExpired(request.pin.requestExpiresAt, "initial create request");
      const metadata = extensionMetadata(request.pin, request.message);
      const response = yield* invoke(options, request.pin, {
        method: "POST",
        url: endpoint(request.pin.interface.url, "message:send"),
        headers: operationHeaders(request.pin),
        body: {
          ...(request.pin.tenantId ? { tenant: request.pin.tenantId } : {}),
          message: wireMessage(request.message),
          configuration: {
            returnImmediately: true,
            ...(request.acceptedOutputModes
              ? { acceptedOutputModes: [...request.acceptedOutputModes] }
              : {}),
          },
          metadata,
        },
      });
      requireSuccess(response, "SendMessage");
      requireDurableEcho(response, request.pin);
      return parseForeignA2ASendResult(requireBody(response), options.validationLimits);
    },
    *sendContinuation(request) {
      assertMessageGuaranteeCurrent(request);
      const response = yield* invoke(options, request.pin, {
        method: "POST",
        url: endpoint(request.pin.interface.url, "message:send"),
        headers: operationHeaders(request.pin),
        body: {
          ...(request.pin.tenantId ? { tenant: request.pin.tenantId } : {}),
          message: wireMessage({
            ...request.message,
            taskId: request.taskId,
            ...(request.contextId ? { contextId: request.contextId } : {}),
          }),
          configuration: { returnImmediately: true },
          metadata: extensionMetadata(request.pin, request.message),
        },
      });
      requireSuccess(response, "SendMessage continuation");
      requireDurableEcho(response, request.pin);
      return parseForeignA2ASendResult(requireBody(response), options.validationLimits);
    },
    *getTask(request) {
      const query = new URLSearchParams();
      if (request.historyLength !== undefined)
        query.set("historyLength", String(request.historyLength));
      if (request.pin.tenantId) query.set("tenant", request.pin.tenantId);
      const suffix = query.size ? `?${query}` : "";
      const response = yield* invoke(options, request.pin, {
        method: "GET",
        url: `${endpoint(request.pin.interface.url, `tasks/${encodeURIComponent(request.taskId)}`)}${suffix}`,
        headers: operationHeaders(request.pin),
      });
      if (response.status === 404)
        throw new CrankError("remote_state_expired", "A2A task is unavailable");
      requireSuccess(response, "GetTask");
      return parseForeignA2ATask(requireBody(response), options.validationLimits);
    },
    *cancelTask(request) {
      const response = yield* invoke(options, request.pin, {
        method: "POST",
        url: endpoint(
          request.pin.interface.url,
          `tasks/${encodeURIComponent(request.taskId)}:cancel`,
        ),
        headers: operationHeaders(request.pin),
        body: request.pin.tenantId ? { tenant: request.pin.tenantId } : {},
      });
      if (response.status === 404)
        throw new CrankError("task_not_found", "A2A task is unavailable");
      if (response.status === 400)
        throw new CrankError("task_not_cancelable", "A2A task is not cancelable");
      requireSuccess(response, "CancelTask");
      return parseForeignA2ATask(requireBody(response), options.validationLimits);
    },
    ...(options.transport
      ? {
          *resolveInvocation(request) {
            const extension = requireDurableExtension(request.pin);
            const response = yield* invoke(options, request.pin, {
              method: "POST",
              url: extension.resolveEndpoint,
              headers: operationHeaders(request.pin),
              body: {
                invocationId: request.pin.invocationId,
                messageDigest: request.messageDigest,
                requestExpiresAt: request.pin.requestExpiresAt,
              },
            });
            requireSuccess(response, "ResolveInvocation");
            requireDurableEcho(response, request.pin);
            return parseResolveResult(requireBody(response), options.validationLimits);
          },
          *abortInvocation(request) {
            const extension = requireDurableExtension(request.pin);
            const response = yield* invoke(options, request.pin, {
              method: "POST",
              url: extension.abortEndpoint,
              headers: operationHeaders(request.pin),
              body: {
                invocationId: request.pin.invocationId,
                messageDigest: request.messageDigest,
                requestExpiresAt: request.pin.requestExpiresAt,
              },
            });
            requireSuccess(response, "AbortInvocation");
            requireDurableEcho(response, request.pin);
            const parsed = parseResolveResult(requireBody(response), options.validationLimits);
            if (parsed.status === "not_found")
              throw new CrankError(
                "a2a_protocol_error",
                "AbortInvocation may not return bare not_found",
              );
            return parsed;
          },
        }
      : {}),
  };
}

export function classifyForeignCancellation(
  value: ForeignA2ATask | CrankError,
): ForeignA2ACancelResult {
  if (value instanceof CrankError) {
    if (value.code === "task_not_found") return { status: "task_not_found_or_expired" };
    if (value.code === "task_not_cancelable") return { status: "not_cancelable" };
    return { status: "transport_indeterminate" };
  }
  if (value.status.state === "canceled") return { status: "confirmed_canceled", task: value };
  if (["completed", "failed", "rejected"].includes(value.status.state))
    return { status: "already_terminal", task: value };
  return { status: "rejected", task: value };
}

function* invoke(
  options: HttpJsonForeignA2AClientOptions,
  pin: ForeignA2AInvocationPin,
  request: Omit<Parameters<ForeignA2AHttpTransport["request"]>[0], "principalId" | "tenantId">,
): Operation<ForeignA2AHttpTransportResponse> {
  try {
    return yield* call(() =>
      options.transport.request({
        ...request,
        principalId: pin.principalId,
        ...(pin.tenantId ? { tenantId: pin.tenantId } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof ForeignA2ATransportError) throw error;
    throw new ForeignA2ATransportError(
      "a2a_transport_lost",
      "Foreign A2A transport lost",
      request.method === "POST",
      { cause: error },
    );
  }
}
function wireMessage(message: ForeignA2AMessage): Json {
  return {
    messageId: message.messageId,
    role: message.role === "user" ? "ROLE_USER" : "ROLE_AGENT",
    parts: message.parts.map((part) => ({
      ...(part.text !== undefined ? { text: part.text } : {}),
      ...(part.raw !== undefined ? { raw: part.raw } : {}),
      ...(part.url !== undefined ? { url: part.url } : {}),
      ...(part.data !== undefined ? { data: part.data } : {}),
      ...(part.filename !== undefined ? { filename: part.filename } : {}),
      ...(part.mediaType !== undefined ? { mediaType: part.mediaType } : {}),
      ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
    })),
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(message.contextId ? { contextId: message.contextId } : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
    ...(message.extensions ? { extensions: [...message.extensions] } : {}),
  };
}
function extensionMetadata(pin: ForeignA2AInvocationPin, message: ForeignA2AMessage): Json {
  if (pin.guarantee.level !== "reconciled") return message.metadata ?? {};
  return {
    ...(record(message.metadata) ? message.metadata : {}),
    [DURABLE_INVOCATION_EXTENSION_URI]: {
      protocolVersion: 1,
      invocationId: pin.invocationId,
      messageId: message.messageId,
      messageDigest: canonicalMessageDigest(message),
      requestExpiresAt: pin.requestExpiresAt,
    },
  };
}
function operationHeaders(pin: ForeignA2AInvocationPin): Record<string, string> {
  return {
    accept: "application/a2a+json",
    "content-type": "application/a2a+json",
    "A2A-Version": pin.interface.protocolVersion,
    ...(pin.guarantee.level === "reconciled"
      ? { [A2A_EXTENSIONS_HEADER]: DURABLE_INVOCATION_EXTENSION_URI }
      : {}),
  };
}
function parseResolveResult(
  value: Json,
  limits?: Partial<ForeignA2AValidationLimits>,
): ResolveForeignInvocationResult {
  if (!record(value) || typeof value["status"] !== "string")
    throw new CrankError("a2a_protocol_error", "Invalid invocation reconciliation response");
  if (value["status"] === "not_found" && Object.keys(value).length === 1)
    return { status: "not_found" };
  if (value["status"] === "aborted" && typeof value["expiresAt"] === "string")
    return { status: "aborted", expiresAt: value["expiresAt"] };
  if (value["status"] === "bound" && value["result"] !== undefined)
    return { status: "bound", result: parseForeignA2ASendResult(value["result"], limits) };
  throw new CrankError("a2a_protocol_error", "Invalid invocation reconciliation response");
}
function assertMessageGuaranteeCurrent(request: ForeignA2AContinueRequest): void {
  const expiry =
    request.messageIdempotencyExpiresAt ?? request.pin.guarantee.messageIdempotencyExpiresAt;
  if (
    ["reconciled", "idempotent_messages"].includes(request.pin.guarantee.level) &&
    (!expiry || Date.now() >= Date.parse(expiry))
  )
    throw new CrankError(
      "a2a_guarantee_expired",
      "Message idempotency guarantee expired before dispatch",
    );
}
function assertNotExpired(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value)) || Date.now() >= Date.parse(value))
    throw new CrankError("a2a_guarantee_expired", `${field} expired before dispatch`);
}
function requireDurableExtension(pin: ForeignA2AInvocationPin) {
  if (pin.guarantee.level !== "reconciled" || !pin.guarantee.extension)
    throw new CrankError("a2a_guarantee_unavailable", "Durable invocation extension is not pinned");
  return pin.guarantee.extension;
}
function endpoint(base: string, suffix: string): string {
  return `${base.replace(/\/$/, "")}/${suffix}`;
}
function requireDurableEcho(
  response: ForeignA2AHttpTransportResponse,
  pin: ForeignA2AInvocationPin,
): void {
  if (pin.guarantee.level !== "reconciled") return;
  const echoed =
    response.headers[A2A_EXTENSIONS_HEADER.toLowerCase()] ??
    response.headers[A2A_EXTENSIONS_HEADER];
  if (
    !echoed
      ?.split(",")
      .map((value) => value.trim())
      .includes(DURABLE_INVOCATION_EXTENSION_URI)
  )
    throw new CrankError("extension_echo_mismatch", "Durable invocation activation was not echoed");
}
function requireSuccess(response: ForeignA2AHttpTransportResponse, operation: string): void {
  if (response.status < 200 || response.status >= 300)
    throw new CrankError("a2a_remote_error", `${operation} failed with status ${response.status}`);
}
function requireBody(response: ForeignA2AHttpTransportResponse): Json {
  if (response.body === undefined)
    throw new CrankError("a2a_protocol_error", "A2A response body is missing");
  return response.body;
}
function canonicalMessageDigest(message: ForeignA2AMessage): string {
  return sha256(canonicalJson(message));
}
function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
