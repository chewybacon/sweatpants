import { CrankError } from "@sweatpants/durable-execution";
import { createHmac } from "node:crypto";
import { assertJson, canonicalJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  createSecureA2AHttpClient,
  parseA2AJsonResponse,
  type A2AAuthorizationProvider,
  type A2AHttpClient,
} from "./http-client.ts";
import { normalizedTransportOrigin, verifyA2AUrl, type A2AUrlPolicy } from "./url-policy.ts";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  type DurableInvocationExtensionParamsV1,
  type ForeignA2AAmbiguityPolicy,
  type ForeignA2AGuarantee,
  type ForeignA2AGuaranteePin,
  type ForeignA2AInterfacePin,
  type ForeignA2AInvocationPin,
} from "./foreign-task-types.ts";

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
  const card = canonicalSnapshot(assertJson(value)).value;
  if (!record(card) || !nonempty(card["name"]) || !nonempty(card["version"])) {
    throw new CrankError("agent_card_invalid", "Invalid A2A Agent Card identity");
  }
  const skills = card["skills"];
  if (
    !Array.isArray(skills) ||
    !skills.some((skill) => record(skill) && skill["id"] === options.skillId)
  ) {
    throw new CrankError("agent_card_invalid", "Selected A2A skill is not advertised");
  }
  const selectedInterface = selectInterface(card, options.bindingPreference);
  await verifyA2AUrl(selectedInterface.url, {
    purpose: "manifest",
    ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
    cardOrigin,
  });
  const securityRequirement = selectSecurityRequirement(card, options.supportedAuthSchemes ?? []);
  const extensions = extensionDeclarations(card);
  const extensionUris = Object.freeze(extensions.map((extension) => String(extension["uri"])));
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
    agentName: card["name"],
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

export function verifyForeignA2AInvocationPin(
  pin: unknown,
): asserts pin is ForeignA2AInvocationPin {
  if (
    !record(pin) ||
    !nonempty(pin["cardDigest"]) ||
    !/^[0-9a-f]{64}$/.test(pin["cardDigest"]) ||
    !nonempty(pin["agentName"]) ||
    !nonempty(pin["skillId"]) ||
    !record(pin["interface"]) ||
    !nonempty(pin["interface"]["url"]) ||
    !nonempty(pin["interface"]["protocolVersion"]) ||
    !Array.isArray(pin["extensionUris"]) ||
    !pin["extensionUris"].every(nonempty) ||
    !record(pin["guarantee"]) ||
    !nonempty(pin["guarantee"]["level"]) ||
    !nonempty(pin["guarantee"]["source"]) ||
    !nonempty(pin["guarantee"]["negotiatedAt"]) ||
    !["surface", "intervene", "retry_may_duplicate"].includes(String(pin["ambiguityPolicy"])) ||
    !nonempty(pin["invocationId"]) ||
    !nonempty(pin["initialMessageId"]) ||
    !nonempty(pin["principalId"]) ||
    !nonempty(pin["requestExpiresAt"]) ||
    (pin["tenantId"] !== undefined && !nonempty(pin["tenantId"]))
  ) {
    throw new CrankError("a2a_pin_invalid", "Foreign A2A invocation pin identity is invalid");
  }
  const candidate = pin as ForeignA2AInvocationPin;
  if (
    !candidate.cardDigest.match(/^[0-9a-f]{64}$/) ||
    !candidate.invocationId ||
    !candidate.initialMessageId ||
    !candidate.principalId ||
    !Number.isFinite(Date.parse(candidate.requestExpiresAt))
  ) {
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
  card: Record<string, Json>,
  preference: readonly ForeignA2AInterfacePin["protocolBinding"][] = [
    "HTTP+JSON",
    "JSONRPC",
    "GRPC",
  ],
): ForeignA2AInterfacePin {
  const interfaces = card["supportedInterfaces"];
  if (!Array.isArray(interfaces)) {
    throw new CrankError("agent_card_invalid", "Agent Card has no interfaces");
  }
  for (const binding of preference) {
    const selected = interfaces.find(
      (candidate) =>
        record(candidate) &&
        candidate["protocolBinding"] === binding &&
        typeof candidate["url"] === "string" &&
        typeof candidate["protocolVersion"] === "string" &&
        /^1(?:\.\d+){0,2}$/.test(candidate["protocolVersion"]),
    );
    if (record(selected)) {
      if (selected["tenant"] !== undefined && typeof selected["tenant"] !== "string") {
        throw new CrankError("agent_card_invalid", "Selected A2A interface tenant is invalid");
      }
      return Object.freeze({
        url: String(selected["url"]),
        protocolBinding: binding,
        protocolVersion: String(selected["protocolVersion"]),
        ...(typeof selected["tenant"] === "string" ? { tenant: selected["tenant"] } : {}),
      });
    }
  }
  throw new CrankError("protocol_version_unsupported", "No supported A2A 1.x interface");
}
function selectSecurityRequirement(card: Record<string, Json>, supported: readonly string[]): Json {
  const requirements = card["securityRequirements"];
  if (requirements === undefined) {
    return {};
  }
  if (!Array.isArray(requirements)) {
    throw new CrankError("agent_card_invalid", "Invalid security requirements");
  }
  if (requirements.length === 0) {
    return {};
  }
  const selected = requirements.find((requirement) => {
    if (!record(requirement) || !record(requirement["schemes"])) {
      return false;
    }
    return Object.keys(requirement["schemes"]).every((scheme) => supported.includes(scheme));
  });
  if (!selected) {
    throw new CrankError("authentication_failed", "No satisfiable Agent Card security requirement");
  }
  return selected;
}
function extensionDeclarations(card: Record<string, Json>): Record<string, Json>[] {
  const capabilities = card["capabilities"];
  const extensions = record(capabilities) ? capabilities["extensions"] : undefined;
  if (extensions === undefined) {
    return [];
  }
  if (!Array.isArray(extensions) || !extensions.every(record)) {
    throw new CrankError("agent_card_invalid", "Invalid Agent Card extension declarations");
  }
  return extensions;
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
  if (
    !record(value) ||
    !exactKeys(value, [
      "protocolVersion",
      "resolveEndpoint",
      "abortEndpoint",
      "retention",
      "messageIdempotency",
    ]) ||
    value["protocolVersion"] !== 1 ||
    value["messageIdempotency"] !== true ||
    typeof value["resolveEndpoint"] !== "string" ||
    typeof value["abortEndpoint"] !== "string" ||
    !record(value["retention"])
  ) {
    throw new CrankError("agent_card_invalid", "Invalid durable-invocation extension parameters");
  }
  const retention = value["retention"];
  const keys = [
    "invocationBindingSeconds",
    "abortTombstoneSeconds",
    "messageIdempotencySeconds",
    "taskSeconds",
    "terminalResultSeconds",
    "clockSkewSeconds",
  ];
  if (!exactKeys(retention, keys)) {
    throw new CrankError("agent_card_invalid", "Invalid durable-invocation retention");
  }
  for (const key of keys) {
    requirePositive(retention[key], key, key === "clockSkewSeconds");
  }
  return Object.freeze({
    protocolVersion: 1,
    resolveEndpoint: value["resolveEndpoint"],
    abortEndpoint: value["abortEndpoint"],
    retention: Object.freeze(
      retention,
    ) as unknown as DurableInvocationExtensionParamsV1["retention"],
    messageIdempotency: true,
  });
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
function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function exactKeys(value: Record<string, Json>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
