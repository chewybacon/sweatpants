import { CrankError } from "@sweatpants/durable-execution";
import { z } from "zod";
import { createHmac } from "node:crypto";
import {
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  failure,
  parser,
  success,
  type Json,
  type Parser,
} from "@sweatpants/foundation";
import {
  createSecureA2AHttpClient,
  parseA2AJsonResponse,
  type A2AAuthorizationProvider,
  type A2AHttpClient,
} from "./http-client.ts";
import { normalizedTransportOrigin, verifyA2AUrl, type A2AUrlPolicy } from "./url-policy.ts";
import { assertBoundedA2AJson } from "./json-bounds.ts";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  type DurableInvocationExtensionParamsV1,
  type ForeignA2AAmbiguityPolicy,
  type ForeignA2AGuarantee,
  type ForeignA2AGuaranteePin,
  type ForeignA2AInterfacePin,
  type ForeignA2AInvocationPin,
} from "./foreign-task-types.ts";

const interfaceSchema = z.looseObject({
  url: z.string(),
  protocolBinding: z.enum(["HTTP+JSON", "JSONRPC", "GRPC"]),
  protocolVersion: z.string().regex(/^1(?:\.\d+){0,2}$/u),
  tenant: z.string().optional(),
});
const securityRequirementSchema = z.looseObject({
  schemes: z.record(z.string(), z.json()),
});
const extensionDeclarationSchema = z.looseObject({
  uri: z.string(),
  params: z.json().optional(),
});
const foreignAgentCardSchema = z.looseObject({
  name: z.string().min(1),
  version: z.string().min(1),
  skills: z.array(z.looseObject({ id: z.string().min(1) })).max(1_024),
  supportedInterfaces: z.array(interfaceSchema).max(128),
  securityRequirements: z.array(securityRequirementSchema).max(128).optional(),
  capabilities: z
    .looseObject({ extensions: z.array(extensionDeclarationSchema).max(128).optional() })
    .optional(),
});
const durableInvocationParamsSchema = z.strictObject({
  protocolVersion: z.literal(1),
  resolveEndpoint: z.string(),
  abortEndpoint: z.string(),
  retention: z.strictObject({
    invocationBindingSeconds: z.number().int().positive(),
    abortTombstoneSeconds: z.number().int().positive(),
    messageIdempotencySeconds: z.number().int().positive(),
    taskSeconds: z.number().int().positive(),
    terminalResultSeconds: z.number().int().positive(),
    clockSkewSeconds: z.number().int().nonnegative(),
  }),
  messageIdempotency: z.literal(true),
});
const foreignAgentCardParser = parser(foreignAgentCardSchema);
export const durableInvocationParamsParser: Parser<DurableInvocationExtensionParamsV1> = parser(
  durableInvocationParamsSchema,
).map((value) => ({
  protocolVersion: 1,
  resolveEndpoint: value.resolveEndpoint,
  abortEndpoint: value.abortEndpoint,
  retention: Object.freeze(value.retention),
  messageIdempotency: true,
}));

type ForeignAgentCard = z.output<typeof foreignAgentCardSchema>;

export interface ForeignA2ADiscoveryOptions {
  readonly source:
    | { card: unknown; cardUrl?: string; cardOrigin?: string }
    | { cardUrl: string }
    | { origin: string };
  readonly skillId: string;
  readonly principalId: string;
  readonly tenantId?: string;
  readonly supportedAuthSchemes?: readonly string[];
  readonly minimumGuarantee?: ForeignA2AGuarantee;
  readonly ambiguityPolicy?: ForeignA2AAmbiguityPolicy;
  readonly idempotentMessagesAttestation?: {
    readonly source: "operator_attestation" | "idempotency_extension";
    readonly retentionSeconds: number;
    readonly extensionUri?: string;
  };
  readonly bindingPreference?: readonly ForeignA2AInterfacePin["protocolBinding"][];
  readonly httpClient?: A2AHttpClient;
  readonly authorization?: A2AAuthorizationProvider;
  readonly urlPolicy?: A2AUrlPolicy;
  readonly signal?: AbortSignal;
  readonly now?: Date;
}
export interface DiscoveredForeignA2AAgent {
  readonly card: Json;
  readonly cardDigest: string;
  readonly cardOrigin: string;
  readonly agentName: string;
  readonly skillId: string;
  readonly interface: ForeignA2AInterfacePin;
  readonly extensionUris: readonly string[];
  readonly guarantee: ForeignA2AGuaranteePin;
  readonly securityRequirement: Json;
}

export async function discoverForeignA2AAgent(
  options: ForeignA2ADiscoveryOptions,
): Promise<DiscoveredForeignA2AAgent> {
  const client = options.httpClient ?? createSecureA2AHttpClient();
  let value: unknown;
  let cardOrigin: string | undefined;
  if ("card" in options.source) {
    value = options.source.card;
    cardOrigin =
      options.source.cardOrigin ??
      (options.source.cardUrl ? normalizedTransportOrigin(options.source.cardUrl) : undefined);
  } else {
    const url =
      "origin" in options.source
        ? new URL("/.well-known/agent-card.json", options.source.origin).toString()
        : options.source.cardUrl;
    const response = await client.get({
      url,
      purpose: "agent-card",
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 401) {
      throw new CrankError("authentication_failed", "Agent Card authentication failed");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CrankError("agent_card_invalid", "Agent Card request failed");
    }
    value = parseA2AJsonResponse(response);
    cardOrigin = normalizedTransportOrigin(response.url);
  }
  if (!cardOrigin) {
    throw new CrankError("unsafe_url", "Explicit Agent Card requires its origin");
  }
  let card: Json;
  try {
    assertBoundedA2AJson(value);
    card = canonicalSnapshot(assertJson(value)).value;
  } catch (error) {
    throw new CrankError("agent_card_invalid", "Invalid A2A Agent Card JSON", undefined, {
      cause: error,
    });
  }
  const parsedCard = foreignAgentCardParser.parse(card);
  if (!parsedCard.ok) {
    throw new CrankError("agent_card_invalid", "Invalid A2A Agent Card identity");
  }
  if (!parsedCard.value.skills.some((skill) => skill.id === options.skillId)) {
    throw new CrankError("agent_card_invalid", "Selected A2A skill is not advertised");
  }
  const selectedInterface = selectInterface(parsedCard.value, options.bindingPreference);
  await verifyA2AUrl(selectedInterface.url, {
    purpose: "manifest",
    ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
    cardOrigin,
  });
  const securityRequirement = selectSecurityRequirement(
    parsedCard.value,
    options.supportedAuthSchemes ?? [],
  );
  const extensions = extensionDeclarations(parsedCard.value);
  const extensionUris = Object.freeze(extensions.map((extension) => extension.uri));
  const now = options.now ?? new Date();
  const guarantee = negotiateGuarantee({
    extensions,
    attestation: options.idempotentMessagesAttestation,
    minimum: options.minimumGuarantee ?? "reconciled",
    now,
  });
  if (guarantee.extension) {
    await Promise.all([
      verifyA2AUrl(guarantee.extension.resolveEndpoint, {
        purpose: "manifest",
        ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
        cardOrigin,
      }),
      verifyA2AUrl(guarantee.extension.abortEndpoint, {
        purpose: "manifest",
        ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
        cardOrigin,
      }),
    ]);
  }
  return Object.freeze({
    card,
    cardDigest: canonicalSnapshot(card).sha,
    cardOrigin,
    agentName: parsedCard.value.name,
    skillId: options.skillId,
    interface: selectedInterface,
    extensionUris,
    guarantee,
    securityRequirement,
  });
}

export function prepareForeignA2AInvocation(input: {
  readonly discovery: DiscoveredForeignA2AAgent;
  readonly derivationKey: string | Uint8Array;
  readonly localIdentity: Json;
  readonly principalId: string;
  readonly tenantId?: string;
  readonly ambiguityPolicy?: ForeignA2AAmbiguityPolicy;
  readonly acknowledgeDuplicateRisk?: boolean;
  readonly requestLifetimeMs?: number;
  readonly now?: Date;
}): ForeignA2AInvocationPin {
  const now = input.now ?? new Date();
  const lifetime = input.requestLifetimeMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) {
    throw new CrankError("invalid_descriptor", "A2A request lifetime must be positive");
  }
  if (
    input.tenantId !== undefined &&
    input.discovery.interface.tenant !== undefined &&
    input.tenantId !== input.discovery.interface.tenant
  ) {
    throw new CrankError(
      "a2a_tenant_mismatch",
      "Configured tenant differs from selected Agent Card interface",
    );
  }
  const tenantId = input.discovery.interface.tenant ?? input.tenantId;
  const ambiguityPolicy = input.ambiguityPolicy ?? "surface";
  if (ambiguityPolicy === "retry_may_duplicate" && input.acknowledgeDuplicateRisk !== true) {
    throw new CrankError(
      "a2a_duplicate_risk_not_acknowledged",
      "retry_may_duplicate requires explicit durable acknowledgment",
    );
  }
  const invocationId = deriveForeignA2AIdentity(
    input.derivationKey,
    "invocation",
    input.localIdentity,
  );
  const initialMessageId = deriveForeignA2AIdentity(input.derivationKey, "message", {
    localIdentity: input.localIdentity,
    index: 0,
  });
  const pin = Object.freeze({
    cardDigest: input.discovery.cardDigest,
    agentName: input.discovery.agentName,
    skillId: input.discovery.skillId,
    interface: input.discovery.interface,
    extensionUris: [...input.discovery.extensionUris],
    guarantee: input.discovery.guarantee,
    ambiguityPolicy,
    ...(ambiguityPolicy === "retry_may_duplicate" ? { duplicateRiskAcknowledged: true } : {}),
    invocationId,
    initialMessageId,
    requestExpiresAt: new Date(now.getTime() + lifetime).toISOString(),
    principalId: input.principalId,
    ...(tenantId ? { tenantId } : {}),
  });
  verifyForeignA2AInvocationPin(pin);
  return pin;
}

const pinTextSchema = z.string().min(1).max(4_096);
const invocationPinShapeSchema = z
  .object({
    cardDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    agentName: pinTextSchema,
    skillId: pinTextSchema,
    interface: z.object({ url: pinTextSchema, protocolVersion: pinTextSchema }).loose(),
    extensionUris: z.array(pinTextSchema),
    guarantee: z
      .object({ level: pinTextSchema, source: pinTextSchema, negotiatedAt: pinTextSchema })
      .loose(),
    ambiguityPolicy: z.enum(["surface", "intervene", "retry_may_duplicate"]),
    invocationId: pinTextSchema,
    initialMessageId: pinTextSchema,
    principalId: pinTextSchema,
    requestExpiresAt: pinTextSchema,
    tenantId: pinTextSchema.optional(),
  })
  .loose();
const invocationPinStructureParser = parser(invocationPinShapeSchema);
export const foreignA2AInvocationPinParser: Parser<ForeignA2AInvocationPin> =
  invocationPinStructureParser.andThen((value) => {
    try {
      verifyInvocationPinSemantics(value as ForeignA2AInvocationPin);
      return success(value as ForeignA2AInvocationPin);
    } catch (error) {
      if (error instanceof CrankError) {
        return failure({ path: [], message: error.message, code: error.code });
      }
      throw error;
    }
  });

export function verifyForeignA2AInvocationPin(
  pin: unknown,
): asserts pin is ForeignA2AInvocationPin {
  const parsed = foreignA2AInvocationPinParser.parse(pin);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    throw new CrankError(
      issue?.code?.startsWith("a2a_") ? issue.code : "a2a_pin_invalid",
      issue?.message ?? "Foreign A2A invocation pin identity is invalid",
    );
  }
}

function verifyInvocationPinSemantics(candidate: ForeignA2AInvocationPin): void {
  if (!Number.isFinite(Date.parse(candidate.requestExpiresAt))) {
    throw new CrankError("a2a_pin_invalid", "Foreign A2A invocation pin identity is invalid");
  }
  if (candidate.guarantee.level === "reconciled") {
    if (
      candidate.guarantee.source !== "durable_invocation_extension" ||
      !candidate.extensionUris.includes(DURABLE_INVOCATION_EXTENSION_URI) ||
      !candidate.guarantee.extension
    ) {
      throw new CrankError(
        "a2a_pin_invalid",
        "Reconciled guarantee requires pinned durable-invocation extension evidence",
      );
    }
    parseDurableInvocationParams(candidate.guarantee.extension);
  }
  if (candidate.guarantee.level === "idempotent_messages") {
    if (
      !["idempotency_extension", "operator_attestation"].includes(candidate.guarantee.source) ||
      !candidate.guarantee.messageIdempotencyExpiresAt
    ) {
      throw new CrankError(
        "a2a_pin_invalid",
        "Idempotent-message guarantee requires an attested source and expiration",
      );
    }
  }
  if (
    candidate.ambiguityPolicy === "retry_may_duplicate" &&
    candidate.duplicateRiskAcknowledged !== true
  ) {
    throw new CrankError(
      "a2a_duplicate_risk_not_acknowledged",
      "retry_may_duplicate pin lacks durable duplicate-risk acknowledgment",
    );
  }
}

export function deriveForeignA2AIdentity(
  key: string | Uint8Array,
  purpose: "invocation" | "message",
  durableIdentity: Json,
): string {
  const bytes = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  if (bytes.byteLength < 32) {
    throw new CrankError("invalid_descriptor", "A2A derivation key must be at least 32 bytes");
  }
  const digest = createHmac("sha256", bytes)
    .update(`sweatpants.foreign-a2a.${purpose}.v1\n`)
    .update(canonicalJson(durableIdentity))
    .digest("hex");
  return `${purpose === "invocation" ? "inv" : "msg"}_${digest}`;
}

export function deriveForeignA2AContinuationMessageId(
  key: string | Uint8Array,
  localIdentity: Json,
  continuationIndex: number,
): string {
  if (!Number.isSafeInteger(continuationIndex) || continuationIndex < 1) {
    throw new CrankError("invalid_descriptor", "Continuation index must be positive");
  }
  return deriveForeignA2AIdentity(key, "message", { localIdentity, index: continuationIndex });
}

function selectInterface(
  card: ForeignAgentCard,
  preference: readonly ForeignA2AInterfacePin["protocolBinding"][] = [
    "HTTP+JSON",
    "JSONRPC",
    "GRPC",
  ],
): ForeignA2AInterfacePin {
  for (const binding of preference) {
    const selected = card.supportedInterfaces.find(
      (candidate) => candidate.protocolBinding === binding,
    );
    if (selected) {
      return Object.freeze({
        url: selected.url,
        protocolBinding: binding,
        protocolVersion: selected.protocolVersion,
        ...(selected.tenant === undefined ? {} : { tenant: selected.tenant }),
      });
    }
  }
  throw new CrankError("protocol_version_unsupported", "No supported A2A 1.x interface");
}
function selectSecurityRequirement(card: ForeignAgentCard, supported: readonly string[]): Json {
  const requirements = card.securityRequirements;
  if (!requirements || requirements.length === 0) {
    return {};
  }
  const selected = requirements.find((requirement) =>
    Object.keys(requirement.schemes).every((scheme) => supported.includes(scheme)),
  );
  if (!selected) {
    throw new CrankError("authentication_failed", "No satisfiable Agent Card security requirement");
  }
  return selected as Json;
}
function extensionDeclarations(
  card: ForeignAgentCard,
): Array<Record<string, Json> & { uri: string }> {
  return (card.capabilities?.extensions ?? []) as Array<Record<string, Json> & { uri: string }>;
}
function negotiateGuarantee(input: {
  extensions: readonly Record<string, Json>[];
  attestation?: ForeignA2ADiscoveryOptions["idempotentMessagesAttestation"];
  minimum: ForeignA2AGuarantee;
  now: Date;
}): ForeignA2AGuaranteePin {
  const durable = input.extensions.find(
    (extension) => extension["uri"] === DURABLE_INVOCATION_EXTENSION_URI,
  );
  let pin: ForeignA2AGuaranteePin;
  if (durable) {
    const params = parseDurableInvocationParams(durable["params"]);
    const nowMs = input.now.getTime();
    pin = {
      level: "reconciled",
      source: "durable_invocation_extension",
      negotiatedAt: input.now.toISOString(),
      invocationExpiresAt: plusSeconds(nowMs, params.retention.invocationBindingSeconds),
      messageIdempotencyExpiresAt: plusSeconds(nowMs, params.retention.messageIdempotencySeconds),
      taskExpiresAt: plusSeconds(nowMs, params.retention.taskSeconds),
      terminalResultExpiresAt: plusSeconds(nowMs, params.retention.terminalResultSeconds),
      abortTombstoneExpiresAt: plusSeconds(nowMs, params.retention.abortTombstoneSeconds),
      extension: params,
    };
  } else if (input.attestation) {
    requirePositive(input.attestation.retentionSeconds, "idempotency retention");
    pin = {
      level: "idempotent_messages",
      source: input.attestation.source,
      negotiatedAt: input.now.toISOString(),
      messageIdempotencyExpiresAt: plusSeconds(
        input.now.getTime(),
        input.attestation.retentionSeconds,
      ),
    };
  } else {
    pin = {
      level: "task_handle_only",
      source: "base_task_handle",
      negotiatedAt: input.now.toISOString(),
    };
  }
  if (guaranteeRank(pin.level) < guaranteeRank(input.minimum)) {
    throw new CrankError(
      "a2a_guarantee_unavailable",
      `Remote guarantee ${pin.level} does not satisfy minimum ${input.minimum}`,
    );
  }
  return Object.freeze(pin);
}
export function parseDurableInvocationParams(value: unknown): DurableInvocationExtensionParamsV1 {
  const parsed = durableInvocationParamsParser.parse(value);
  if (!parsed.ok) {
    throw new CrankError("agent_card_invalid", "Invalid durable-invocation extension parameters");
  }
  return Object.freeze(parsed.value);
}
function guaranteeRank(value: ForeignA2AGuarantee): number {
  return { best_effort: 0, task_handle_only: 1, idempotent_messages: 2, reconciled: 3 }[value];
}
function plusSeconds(now: number, seconds: number): string {
  return new Date(now + seconds * 1_000).toISOString();
}
function requirePositive(
  value: unknown,
  field: string,
  allowZero = false,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new CrankError(
      "agent_card_invalid",
      `${field} must be ${allowZero ? "nonnegative" : "positive"}`,
    );
  }
}
