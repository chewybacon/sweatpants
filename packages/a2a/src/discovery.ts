import {
  assertJson,
  canonicalSnapshot,
  failure,
  parser,
  success,
  type Json,
} from "@sweatpants/foundation";
import { z } from "zod";
import type { PinnedProgram } from "@sweatpants/durable-execution";
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
import { normalizedTransportOrigin, verifyA2AUrl, type A2AUrlPolicy } from "./url-policy.ts";

const boundedTextSchema = z.string().min(1).max(256);
const pinnedProgramSchema = z.strictObject({
  id: boundedTextSchema,
  version: boundedTextSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
});
const agentCardCoreSchema = z.looseObject({
  name: boundedTextSchema,
  version: boundedTextSchema,
  supportedInterfaces: z.array(z.unknown()).min(1),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(z.looseObject({ id: boundedTextSchema, name: boundedTextSchema })),
  capabilities: z.looseObject({ extensions: z.array(z.unknown()) }),
});
const extensionIdentitySchema = z.looseObject({ uri: z.string() });
const callerAuthoritativeDeclarationSchema = z.strictObject({
  uri: z.literal(CALLER_AUTHORITATIVE_EXTENSION_URI),
  params: z.json(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});
const callerAuthoritativeParamsSchema = z.strictObject({
  protocolVersion: z.literal(1),
  manifestEndpoint: z.string().min(1).max(4_096),
  driverEndpoint: z.string().min(1).max(4_096),
  programs: z
    .array(
      z.strictObject({
        skillId: boundedTextSchema,
        program: pinnedProgramSchema,
      }),
    )
    .min(1)
    .max(1_024),
});

const agentCardCoreParser = parser(agentCardCoreSchema);
const extensionIdentityParser = parser(extensionIdentitySchema);
const callerAuthoritativeDeclarationParser = parser(callerAuthoritativeDeclarationSchema);

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
  const parsedCard = agentCardCoreParser.parse(card);
  if (!parsedCard.ok) {
    throw a2aError("agent_card_invalid", "Agent Card is missing required A2A fields");
  }
  const declarations = parsedCard.value.capabilities.extensions.filter((value) => {
    const identity = extensionIdentityParser.parse(value);
    return identity.ok && identity.value.uri === CALLER_AUTHORITATIVE_EXTENSION_URI;
  });
  if (declarations.length !== 1) {
    throw a2aError(
      declarations.length === 0 ? "extension_not_advertised" : "agent_card_invalid",
      declarations.length === 0
        ? "Caller-authoritative A2A extension is not advertised"
        : "Caller-authoritative A2A extension is advertised more than once",
    );
  }
  const parsedDeclaration = callerAuthoritativeDeclarationParser.parse(declarations[0]);
  if (!parsedDeclaration.ok) {
    throw a2aError("agent_card_invalid", "Invalid A2A extension declaration");
  }
  const declaration = parsedDeclaration.value;
  const params = parseCallerAuthoritativeExtensionParams(declaration.params);
  const originForEndpoints = cardOrigin;
  if (!originForEndpoints) {
    throw a2aError(
      "unsafe_url",
      "An explicit Agent Card document must include cardUrl or cardOrigin for endpoint policy",
    );
  }
  await Promise.all([
    verifyA2AUrl(params.manifestEndpoint, {
      purpose: "manifest",
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      cardOrigin: originForEndpoints,
    }),
    verifyA2AUrl(params.driverEndpoint, {
      purpose: "driver",
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      cardOrigin: originForEndpoints,
    }),
  ]);
  assertSkillMappings(parsedCard.value.skills, params);
  const snapshot = canonicalSnapshot(card);
  return Object.freeze({
    card: snapshot.value,
    ...(cardUrl ? { cardUrl } : {}),
    cardDigest: snapshot.sha,
    extension: Object.freeze({
      uri: CALLER_AUTHORITATIVE_EXTENSION_URI,
      ...(declaration.description === undefined ? {} : { description: declaration.description }),
      ...(declaration.required === undefined ? {} : { required: declaration.required }),
      params,
    }),
    programForSkill(skillId: string): PinnedProgram {
      const mapping = params.programs.find((candidate) => candidate.skillId === skillId);
      if (!mapping) {
        throw a2aError("authorization_denied", "Requested A2A skill is unavailable");
      }
      return structuredClone(mapping.program);
    },
  });
}

export const pinnedProgramParser = parser(pinnedProgramSchema).map(
  (value): PinnedProgram => Object.freeze(value),
);

export const callerAuthoritativeExtensionParamsParser = parser(
  callerAuthoritativeParamsSchema,
).andThen((value) => {
  const skills = new Set<string>();
  const programs: { skillId: string; program: PinnedProgram }[] = [];
  for (const [index, mapping] of value.programs.entries()) {
    if (skills.has(mapping.skillId)) {
      return failure({
        path: ["programs", index, "skillId"],
        message: "Duplicate A2A skill mapping",
      });
    }
    skills.add(mapping.skillId);
    programs.push({
      skillId: mapping.skillId,
      program: Object.freeze(mapping.program),
    });
  }
  return success(
    Object.freeze({
      protocolVersion: 1 as const,
      manifestEndpoint: value.manifestEndpoint,
      driverEndpoint: value.driverEndpoint,
      programs: programs.map((entry) => Object.freeze(entry)),
    }),
  );
});

export function parseCallerAuthoritativeExtensionParams(
  value: unknown,
): CallerAuthoritativeProgramExtensionParamsV1 {
  const parsed = callerAuthoritativeExtensionParamsParser.parse(value);
  if (!parsed.ok) {
    throw a2aError("agent_card_invalid", "Invalid caller-authoritative extension parameters");
  }
  return parsed.value;
}

export function parsePinnedProgram(value: unknown): PinnedProgram {
  const parsed = pinnedProgramParser.parse(value);
  if (!parsed.ok) {
    throw a2aError("agent_card_invalid", "Invalid pinned A2A program identity");
  }
  return parsed.value;
}

function assertSkillMappings(
  skills: readonly { readonly id: string }[],
  params: CallerAuthoritativeProgramExtensionParamsV1,
): void {
  const ids = new Set(skills.map((skill) => skill.id));
  for (const mapping of params.programs) {
    if (!ids.has(mapping.skillId)) {
      throw a2aError("agent_card_invalid", "Extension maps an undeclared Agent Card skill");
    }
  }
}

function classifyHttpStatus(status: number, resource: "agent-card" | "manifest"): void {
  if (status >= 200 && status < 300) {
    return;
  }
  if (status === 401) {
    throw a2aError("authentication_failed", `A2A ${resource} authentication failed`);
  }
  if (status === 403 || status === 404) {
    throw a2aError("authorization_denied", `A2A ${resource} is unavailable`);
  }
  throw a2aError("transport_lost", `A2A ${resource} request failed with status ${status}`);
}
