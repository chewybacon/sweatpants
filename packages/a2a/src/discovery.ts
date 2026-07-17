import {
  assertJson,
  canonicalSnapshot,
  type Json,
  type PinnedProgram,
} from "@sweatpants/session-contract";
import {
  CALLER_AUTHORITATIVE_EXTENSION_URI,
  type CallerAuthoritativeProgramExtensionParamsV1,
  type DiscoveredCallerAuthoritativeProgramV1,
} from "./types.ts";
import { a2aError } from "./protocol.ts";
import {
  createSecureA2AHttpClient,
  parseA2AJsonResponse,
  type A2AAuthorizationProvider,
  type A2AHttpClient,
} from "./http-client.ts";
import { normalizedTransportOrigin, validateA2AUrl, type A2AUrlPolicy } from "./url-policy.ts";

export type A2AAgentCardSource =
  | { card: unknown; cardUrl?: string; cardOrigin?: string }
  | { cardUrl: string }
  | { origin: string };

export interface DiscoverA2AProgramOptions {
  source: A2AAgentCardSource;
  httpClient?: A2AHttpClient;
  authorization?: A2AAuthorizationProvider;
  urlPolicy?: A2AUrlPolicy;
  signal?: AbortSignal;
}

/** Discovers and closes the caller-authoritative extension before child allocation. */
export async function discoverCallerAuthoritativeProgram(
  options: DiscoverA2AProgramOptions,
): Promise<DiscoveredCallerAuthoritativeProgramV1> {
  const client = options.httpClient ?? createSecureA2AHttpClient();
  let cardValue: unknown;
  let cardUrl: string | undefined;
  let cardOrigin: string | undefined;
  if ("card" in options.source) {
    cardValue = options.source.card;
    cardUrl = options.source.cardUrl;
    cardOrigin =
      options.source.cardOrigin ?? (cardUrl ? normalizedTransportOrigin(cardUrl) : undefined);
  } else {
    cardUrl =
      "origin" in options.source
        ? new URL("/.well-known/agent-card.json", options.source.origin).toString()
        : options.source.cardUrl;
    const response = await client.get({
      url: cardUrl,
      purpose: "agent-card",
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    classifyHttpStatus(response.status, "agent-card");
    cardValue = parseA2AJsonResponse(response);
    cardUrl = response.url.toString();
    cardOrigin = normalizedTransportOrigin(response.url);
  }
  let card: Json;
  try {
    card = assertJson(cardValue);
  } catch (error) {
    throw a2aError("agent_card_invalid", "Agent Card is not canonical JSON", error);
  }
  if (!record(card)) throw a2aError("agent_card_invalid", "Agent Card must be an object");
  validateAgentCardCore(card);
  const capabilities = card["capabilities"];
  if (!record(capabilities) || !Array.isArray(capabilities["extensions"])) {
    throw a2aError("extension_not_advertised", "Agent Card does not advertise extensions");
  }
  const declarations = capabilities["extensions"].filter(
    (value): value is Record<string, Json> =>
      record(value) && value["uri"] === CALLER_AUTHORITATIVE_EXTENSION_URI,
  );
  if (declarations.length !== 1) {
    throw a2aError(
      declarations.length === 0 ? "extension_not_advertised" : "agent_card_invalid",
      declarations.length === 0
        ? "Caller-authoritative A2A extension is not advertised"
        : "Caller-authoritative A2A extension is advertised more than once",
    );
  }
  const declaration = declarations[0]!;
  if (
    !onlyKeys(declaration, ["uri", "params"], ["description", "required"]) ||
    (declaration["description"] !== undefined && typeof declaration["description"] !== "string") ||
    (declaration["required"] !== undefined && typeof declaration["required"] !== "boolean")
  ) {
    throw a2aError("agent_card_invalid", "Invalid A2A extension declaration");
  }
  const params = parseCallerAuthoritativeExtensionParams(declaration["params"]);
  const originForEndpoints = cardOrigin;
  if (!originForEndpoints) {
    throw a2aError(
      "unsafe_url",
      "An explicit Agent Card document must include cardUrl or cardOrigin for endpoint policy",
    );
  }
  await Promise.all([
    validateA2AUrl(params.manifestEndpoint, {
      purpose: "manifest",
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      cardOrigin: originForEndpoints,
    }),
    validateA2AUrl(params.driverEndpoint, {
      purpose: "driver",
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      cardOrigin: originForEndpoints,
    }),
  ]);
  validateSkillMappings(card, params);
  const snapshot = canonicalSnapshot(card);
  return Object.freeze({
    card: snapshot.value,
    ...(cardUrl ? { cardUrl } : {}),
    cardDigest: snapshot.sha,
    extension: Object.freeze({
      uri: CALLER_AUTHORITATIVE_EXTENSION_URI,
      ...(typeof declaration["description"] === "string"
        ? { description: declaration["description"] }
        : {}),
      ...(typeof declaration["required"] === "boolean"
        ? { required: declaration["required"] }
        : {}),
      params,
    }),
    programForSkill(skillId: string): PinnedProgram {
      const mapping = params.programs.find((candidate) => candidate.skillId === skillId);
      if (!mapping) throw a2aError("authorization_denied", "Requested A2A skill is unavailable");
      return structuredClone(mapping.program);
    },
  });
}

export function parseCallerAuthoritativeExtensionParams(
  value: unknown,
): CallerAuthoritativeProgramExtensionParamsV1 {
  if (
    !record(value) ||
    !exactKeys(value, ["protocolVersion", "manifestEndpoint", "driverEndpoint", "programs"]) ||
    value["protocolVersion"] !== 1 ||
    typeof value["manifestEndpoint"] !== "string" ||
    typeof value["driverEndpoint"] !== "string" ||
    !Array.isArray(value["programs"]) ||
    value["programs"].length === 0
  ) {
    throw a2aError("agent_card_invalid", "Invalid caller-authoritative extension parameters");
  }
  const skills = new Set<string>();
  const programs = value["programs"].map((mapping) => {
    if (
      !record(mapping) ||
      !exactKeys(mapping, ["skillId", "program"]) ||
      !nonempty(mapping["skillId"])
    )
      throw a2aError("agent_card_invalid", "Invalid A2A skill mapping");
    if (skills.has(mapping["skillId"]))
      throw a2aError("agent_card_invalid", "Duplicate A2A skill mapping");
    skills.add(mapping["skillId"]);
    const program = parsePinnedProgram(mapping["program"]);
    return Object.freeze({ skillId: mapping["skillId"], program });
  });
  return Object.freeze({
    protocolVersion: 1,
    manifestEndpoint: value["manifestEndpoint"],
    driverEndpoint: value["driverEndpoint"],
    programs: Object.freeze(
      programs,
    ) as unknown as CallerAuthoritativeProgramExtensionParamsV1["programs"],
  });
}

export function parsePinnedProgram(value: unknown): PinnedProgram {
  if (!record(value) || !exactKeys(value, ["id", "version", "digest"]))
    throw a2aError("agent_card_invalid", "Invalid pinned A2A program identity");
  if (!nonempty(value["id"]) || !nonempty(value["version"]) || !digest(value["digest"]))
    throw a2aError("agent_card_invalid", "Invalid pinned A2A program identity");
  return Object.freeze({ id: value["id"], version: value["version"], digest: value["digest"] });
}

function validateAgentCardCore(card: Record<string, Json>): void {
  if (
    !nonempty(card["name"]) ||
    !nonempty(card["version"]) ||
    !Array.isArray(card["supportedInterfaces"]) ||
    card["supportedInterfaces"].length === 0 ||
    !Array.isArray(card["defaultInputModes"]) ||
    !card["defaultInputModes"].every((mode) => typeof mode === "string") ||
    !Array.isArray(card["defaultOutputModes"]) ||
    !card["defaultOutputModes"].every((mode) => typeof mode === "string") ||
    !Array.isArray(card["skills"])
  ) {
    throw a2aError("agent_card_invalid", "Agent Card is missing required A2A fields");
  }
  for (const skill of card["skills"]) {
    if (!record(skill) || !nonempty(skill["id"]) || !nonempty(skill["name"])) {
      throw a2aError("agent_card_invalid", "Agent Card contains an invalid skill");
    }
  }
}

function validateSkillMappings(
  card: Record<string, Json>,
  params: CallerAuthoritativeProgramExtensionParamsV1,
): void {
  const skills = card["skills"];
  if (!Array.isArray(skills))
    throw a2aError("agent_card_invalid", "Agent Card skills must be an array");
  const ids = new Set(
    skills.flatMap((skill) => (record(skill) && nonempty(skill["id"]) ? [skill["id"]] : [])),
  );
  for (const mapping of params.programs) {
    if (!ids.has(mapping.skillId)) {
      throw a2aError("agent_card_invalid", "Extension maps an undeclared Agent Card skill");
    }
  }
}

function classifyHttpStatus(status: number, resource: "agent-card" | "manifest"): void {
  if (status >= 200 && status < 300) return;
  if (status === 401)
    throw a2aError("authentication_failed", `A2A ${resource} authentication failed`);
  if (status === 403 || status === 404)
    throw a2aError("authorization_denied", `A2A ${resource} is unavailable`);
  throw a2aError("transport_lost", `A2A ${resource} request failed with status ${status}`);
}

function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function exactKeys(value: Record<string, Json>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function onlyKeys(
  value: Record<string, Json>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}
