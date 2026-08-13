import { CrankError } from "@sweatpants/durable-execution";
import { hasControlCharacter } from "@sweatpants/foundation";
import { type SandboxCapabilities, type WorkspacePersistence } from "@sweatpants/workspace-runtime";
import { canonicalSnapshot, sortStrings, type Json } from "@sweatpants/foundation";

export type WorkspaceNetworkPolicy = "deny" | "trusted-development";
export type WorkspaceWritePolicy = "deny" | "approval" | "allow";
export type ExternalEffectPolicy = "host-only" | "trusted-development";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface SecretReference {
  readonly format: "sweatpants.secret-ref.v1";
  readonly name: string;
}

export type WorkspaceSource =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "git"; readonly url: string; readonly ref: string };

export interface WorkspaceDefinition {
  readonly format: "sweatpants.workspace-definition.v1";
  readonly digest: string;
  readonly source: WorkspaceSource;
  readonly root: string;
  readonly packageManager: PackageManager;
  readonly setup: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly secrets: readonly SecretReference[];
  readonly policy: {
    readonly network: WorkspaceNetworkPolicy;
    readonly writes: WorkspaceWritePolicy;
    readonly externalEffects: ExternalEffectPolicy;
  };
  readonly persistence: WorkspacePersistence;
}

export interface DefineWorkspaceOptions {
  readonly source: WorkspaceSource;
  readonly root?: string;
  readonly packageManager: PackageManager;
  readonly setup?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
  readonly secrets?: readonly SecretReference[];
  readonly policy: WorkspaceDefinition["policy"];
  readonly persistence: WorkspacePersistence;
}

export interface SandboxProviderDefinition {
  readonly format: "sweatpants.sandbox-provider.v1";
  readonly digest: string;
  readonly kind: "lambda-microvm";
  readonly image: {
    readonly name: string;
    readonly version: string;
    readonly node: string;
    readonly architecture: "arm64";
  };
  readonly lifecycle: {
    readonly warmIdleSeconds: number;
    readonly suspendedLifetimeSeconds: number;
    readonly autoResume: boolean;
  };
  readonly capabilities: SandboxCapabilities;
}

export interface LambdaMicrovmOptions {
  readonly image: SandboxProviderDefinition["image"];
  readonly lifecycle: SandboxProviderDefinition["lifecycle"];
  readonly checkpointRestore?: boolean;
  readonly ports?: boolean;
}

export interface ModelProviderDefinition {
  readonly format: "sweatpants.model-provider.v1";
  readonly name: string;
  readonly adapter: string;
  readonly model: { readonly provider: string; readonly id: string };
}

export interface ModelSamplingDefinition {
  readonly format: "sweatpants.model-sampling.v1";
  readonly provider: string;
  readonly ownership: "host" | "client";
}

export interface JournalAuthorityDefinition {
  readonly kind: "development-memory" | "durable-port";
  readonly binding?: string;
}

export interface ProjectionDefinition {
  readonly kind: "react-chat" | "headless-http" | "mcp";
  readonly path?: string;
  readonly protocolVersion?: "2025-11-25";
}

interface ProgramDefinition {
  readonly manifest: {
    readonly programId: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly childPrograms?: Readonly<
    Record<string, ProgramDefinition | { readonly program: ProgramDefinition }>
  >;
}

export interface DeploymentDefinition<
  Programs extends Readonly<Record<string, ProgramDefinition>>,
  Capabilities extends Readonly<Record<string, ProgramDefinition>>,
> {
  readonly format: "sweatpants.deployment.v1";
  readonly digest: string;
  readonly name: string;
  readonly mode: "development" | "production";
  readonly authority: JournalAuthorityDefinition;
  readonly modelProvider: ModelProviderDefinition;
  readonly modelSampling: ModelSamplingDefinition;
  readonly programs: Programs;
  readonly capabilities: Capabilities;
  readonly workspace: WorkspaceDefinition;
  readonly sandbox: SandboxProviderDefinition;
  readonly projections: readonly ProjectionDefinition[];
}

export interface DefineDeploymentOptions<
  Programs extends Readonly<Record<string, ProgramDefinition>>,
  Capabilities extends Readonly<Record<string, ProgramDefinition>>,
> {
  readonly name: string;
  readonly mode: "development" | "production";
  readonly authority: JournalAuthorityDefinition;
  readonly modelProvider: ModelProviderDefinition;
  readonly modelSampling: ModelSamplingDefinition;
  readonly programs: Programs;
  readonly capabilities: Capabilities;
  readonly workspace: WorkspaceDefinition;
  readonly sandbox: SandboxProviderDefinition;
  readonly projections: readonly ProjectionDefinition[];
}

export class DeploymentAuthoringError extends CrankError {
  readonly _deploymentAuthoringTag = "DeploymentAuthoringError";
}

export const workspaceSource = Object.freeze({
  local(path: string): WorkspaceSource {
    return Object.freeze({ kind: "local", path: safeRelativePath(path, "local source path") });
  },
  git(options: { readonly url: string; readonly ref: string }): WorkspaceSource {
    exactKeys(options, ["url", "ref"], "git workspace source");
    const url = boundedText(options.url, 2_048, "git source URL");
    if (!URL.canParse(url)) {
      invalid("git source URL must be absolute");
    }
    return Object.freeze({
      kind: "git",
      url,
      ref: boundedText(options.ref, 256, "git source ref"),
    });
  },
});

export function secretRef(name: string): SecretReference {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
    invalid("secret reference must be an uppercase environment-style name");
  }
  return Object.freeze({ format: "sweatpants.secret-ref.v1", name });
}

export function defineWorkspace(options: DefineWorkspaceOptions): WorkspaceDefinition {
  exactKeys(
    options,
    ["source", "root", "packageManager", "setup", "scripts", "secrets", "policy", "persistence"],
    "workspace definition",
  );
  exactKeys(options.policy, ["network", "writes", "externalEffects"], "workspace policy");
  const source = normalizeSource(options.source);
  const setup = Object.freeze(
    (options.setup ?? []).map((command) => boundedCommand(command, "setup")),
  );
  const scripts = normalizeScripts(options.scripts ?? {});
  const secrets = Object.freeze([...(options.secrets ?? [])].map(normalizeSecretRef));
  if (new Set(secrets.map((secret) => secret.name)).size !== secrets.length) {
    invalid("workspace secret references must be unique");
  }
  const document = {
    format: "sweatpants.workspace-definition.v1" as const,
    source,
    root: safeRelativePath(options.root ?? ".", "workspace root"),
    packageManager: oneOf(
      options.packageManager,
      ["npm", "pnpm", "yarn", "bun"],
      "package manager",
    ),
    setup,
    scripts,
    secrets,
    policy: Object.freeze({
      network: oneOf(options.policy.network, ["deny", "trusted-development"], "network policy"),
      writes: oneOf(options.policy.writes, ["deny", "approval", "allow"], "write policy"),
      externalEffects: oneOf(
        options.policy.externalEffects,
        ["host-only", "trusted-development"],
        "external effect policy",
      ),
    }),
    persistence: oneOf(
      options.persistence,
      ["none", "sandbox_lease", "provider_durable", "checkpoint_restore"],
      "workspace persistence",
    ),
  };
  return Object.freeze({
    ...document,
    digest: digest("sweatpants.workspace-definition.v1", document),
  });
}

export function lambdaMicrovm(options: LambdaMicrovmOptions): SandboxProviderDefinition {
  exactKeys(
    options,
    ["image", "lifecycle", "checkpointRestore", "ports"],
    "Lambda MicroVM provider",
  );
  exactKeys(options.image, ["name", "version", "node", "architecture"], "Lambda MicroVM image");
  exactKeys(
    options.lifecycle,
    ["warmIdleSeconds", "suspendedLifetimeSeconds", "autoResume"],
    "Lambda MicroVM lifecycle",
  );
  if (options.image.architecture !== "arm64") {
    invalid("Lambda MicroVM images require arm64");
  }
  positiveInteger(options.lifecycle.warmIdleSeconds, "warm idle seconds");
  positiveInteger(options.lifecycle.suspendedLifetimeSeconds, "suspended lifetime seconds");
  if (options.lifecycle.warmIdleSeconds < 60) {
    invalid("Lambda MicroVM warm idle seconds must be at least 60");
  }
  if (options.lifecycle.suspendedLifetimeSeconds > 28_800) {
    invalid("Lambda MicroVM suspended lifetime cannot exceed eight hours");
  }
  if (options.lifecycle.warmIdleSeconds >= options.lifecycle.suspendedLifetimeSeconds) {
    invalid("Lambda MicroVM suspended lifetime must exceed its warm idle lifetime");
  }
  const checkpointRestore = options.checkpointRestore ?? false;
  const document = {
    format: "sweatpants.sandbox-provider.v1" as const,
    kind: "lambda-microvm" as const,
    image: Object.freeze({
      name: boundedText(options.image.name, 128, "image name"),
      version: boundedText(options.image.version, 128, "image version"),
      node: boundedText(options.image.node, 32, "Node runtime"),
      architecture: "arm64" as const,
    }),
    lifecycle: Object.freeze({ ...options.lifecycle }),
    capabilities: Object.freeze({
      requestResponse: true as const,
      websocket: false,
      warmAttachments: true,
      memorySuspend: true,
      localDisk: true,
      workspacePersistence: checkpointRestore
        ? ("checkpoint_restore" as const)
        : ("sandbox_lease" as const),
      checkpointRestore,
      shell: true,
      processExecution: true,
      ports: options.ports ?? false,
      networkPolicy: false,
    }),
  };
  return Object.freeze({ ...document, digest: digest("sweatpants.sandbox-provider.v1", document) });
}

export function defineModelProvider(options: {
  readonly name: string;
  readonly adapter: string;
  readonly model: { readonly provider: string; readonly id: string };
}): ModelProviderDefinition {
  exactKeys(options, ["name", "adapter", "model"], "model provider");
  exactKeys(options.model, ["provider", "id"], "model selection");
  return Object.freeze({
    format: "sweatpants.model-provider.v1",
    name: stableName(options.name, "model provider name"),
    adapter: stableName(options.adapter, "model provider adapter"),
    model: Object.freeze({
      provider: stableName(options.model.provider, "model provider"),
      id: boundedText(options.model.id, 256, "model ID"),
    }),
  });
}

export function hostModelSampling(provider: ModelProviderDefinition): ModelSamplingDefinition {
  return Object.freeze({
    format: "sweatpants.model-sampling.v1",
    provider: provider.name,
    ownership: "host",
  });
}

export function clientModelSampling(provider: ModelProviderDefinition): ModelSamplingDefinition {
  return Object.freeze({
    format: "sweatpants.model-sampling.v1",
    provider: provider.name,
    ownership: "client",
  });
}

export function developmentJournal(): JournalAuthorityDefinition {
  return Object.freeze({ kind: "development-memory" });
}

export function durableJournal(binding: string): JournalAuthorityDefinition {
  return Object.freeze({
    kind: "durable-port",
    binding: boundedText(binding, 128, "journal binding"),
  });
}

export function reactChat(path = "/"): ProjectionDefinition {
  return Object.freeze({ kind: "react-chat", path: routePath(path) });
}

export function headlessHttp(path = "/api/tasks"): ProjectionDefinition {
  return Object.freeze({ kind: "headless-http", path: routePath(path) });
}

export function streamableMcp(path = "/mcp"): ProjectionDefinition {
  return Object.freeze({ kind: "mcp", path: routePath(path), protocolVersion: "2025-11-25" });
}

export function defineDeployment<
  Programs extends Readonly<Record<string, ProgramDefinition>>,
  Capabilities extends Readonly<Record<string, ProgramDefinition>>,
>(
  options: DefineDeploymentOptions<Programs, Capabilities>,
): DeploymentDefinition<Programs, Capabilities> {
  exactKeys(
    options,
    [
      "name",
      "mode",
      "authority",
      "modelProvider",
      "modelSampling",
      "programs",
      "capabilities",
      "workspace",
      "sandbox",
      "projections",
    ],
    "deployment definition",
  );
  const name = stableName(options.name, "deployment name");
  if (Object.keys(options.programs).length === 0) {
    invalid("deployment must expose at least one program");
  }
  if (options.mode === "production" && options.authority.kind === "development-memory") {
    invalid("production deployment requires a durable journal port");
  }
  if (options.modelSampling.provider !== options.modelProvider.name) {
    invalid("model sampling provider does not match the deployment model provider");
  }
  assertWorkspaceProviderCompatibility(options.workspace, options.sandbox);
  assertProgramCapabilityConsistency(options.programs, options.capabilities);
  const projectionKinds = options.projections.map((projection) => projection.kind);
  if (new Set(projectionKinds).size !== projectionKinds.length) {
    invalid("deployment projections must be unique by kind");
  }
  const projectionPaths = options.projections
    .map((projection) => projection.path)
    .filter((path): path is string => path !== undefined);
  if (new Set(projectionPaths).size !== projectionPaths.length) {
    invalid("deployment projection paths must be unique");
  }
  const identity = {
    format: "sweatpants.deployment.v1" as const,
    name,
    mode: options.mode,
    authority: options.authority,
    modelProvider: options.modelProvider,
    modelSampling: options.modelSampling,
    programs: pins(options.programs),
    capabilities: pins(options.capabilities),
    workspaceDigest: options.workspace.digest,
    sandboxDigest: options.sandbox.digest,
    projections: options.projections,
  };
  return Object.freeze({
    format: "sweatpants.deployment.v1",
    digest: digest("sweatpants.deployment.v1", identity),
    name,
    mode: options.mode,
    authority: options.authority,
    modelProvider: options.modelProvider,
    modelSampling: options.modelSampling,
    programs: options.programs,
    capabilities: options.capabilities,
    workspace: options.workspace,
    sandbox: options.sandbox,
    projections: Object.freeze([...options.projections]),
  });
}

function assertProgramCapabilityConsistency(
  programs: Readonly<Record<string, ProgramDefinition>>,
  capabilities: Readonly<Record<string, ProgramDefinition>>,
): void {
  for (const [capabilityName, capability] of Object.entries(capabilities)) {
    const references = Object.entries(programs).flatMap(([programName, program]) => {
      const binding = program.childPrograms?.[capabilityName];
      return binding ? [{ programName, binding }] : [];
    });
    if (references.length === 0) {
      invalid(`deployment capability ${capabilityName} is not referenced by any program`);
    }
    for (const { programName, binding } of references) {
      const bindingProgram = "program" in binding ? binding.program : binding;
      if (
        capability.manifest.programId !== bindingProgram.manifest.programId ||
        capability.manifest.version !== bindingProgram.manifest.version ||
        capability.manifest.digest !== bindingProgram.manifest.digest
      ) {
        invalid(`program ${programName} capability ${capabilityName} does not match its binding`);
      }
    }
  }
}

function assertWorkspaceProviderCompatibility(
  workspace: WorkspaceDefinition,
  sandbox: SandboxProviderDefinition,
): void {
  if (workspace.policy.network === "deny" && !sandbox.capabilities.networkPolicy) {
    invalid("workspace requires deny-network enforcement but provider cannot enforce it");
  }
  const persistence = sandbox.capabilities.workspacePersistence;
  if (workspace.persistence === "sandbox_lease" && persistence === "none") {
    invalid("workspace requires lease persistence but provider has none");
  }
  if (workspace.persistence === "provider_durable" && persistence !== "provider_durable") {
    invalid("workspace requires provider-durable persistence");
  }
  if (workspace.persistence === "checkpoint_restore" && !sandbox.capabilities.checkpointRestore) {
    invalid("workspace requires checkpoint restore but provider does not provide it");
  }
}

function normalizeSource(source: WorkspaceSource): WorkspaceSource {
  if (source.kind === "local") {
    exactKeys(source, ["kind", "path"], "local workspace source");
    return workspaceSource.local(source.path);
  }
  if (source.kind === "git") {
    exactKeys(source, ["kind", "url", "ref"], "git workspace source");
    return workspaceSource.git({ url: source.url, ref: source.ref });
  }
  return invalid("unsupported workspace source");
}

function normalizeSecretRef(value: SecretReference): SecretReference {
  exactKeys(value, ["format", "name"], "secret reference");
  if (value.format !== "sweatpants.secret-ref.v1") {
    invalid("unsupported secret reference format");
  }
  return secretRef(value.name);
}

function normalizeScripts(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const scripts: Record<string, string> = {};
  for (const name of sortStrings(Object.keys(input))) {
    scripts[stableName(name, "script name")] = boundedCommand(input[name]!, `script ${name}`);
  }
  return Object.freeze(scripts);
}

function pins(input: Readonly<Record<string, ProgramDefinition>>): Json {
  const output: Record<string, Json> = {};
  for (const name of sortStrings(Object.keys(input))) {
    const manifest = input[name]!.manifest;
    output[stableName(name, "program binding")] = {
      id: boundedText(manifest.programId, 256, "program ID"),
      version: boundedText(manifest.version, 128, "program version"),
      digest: sha(manifest.digest, "program digest"),
    };
  }
  return output;
}

function digest(domain: string, value: unknown): string {
  return canonicalSnapshot({ domain, value }).sha;
}

function exactKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const unknown = sortStrings(Object.keys(value)).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    invalid(`${label} has unknown fields: ${unknown.join(", ")}`);
  }
}

function boundedText(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    invalid(`${label} must contain 1..${maximum} characters`);
  }
  return value;
}

function boundedCommand(value: string, label: string): string {
  return boundedText(value, 4_096, `${label} command`);
}

function safeRelativePath(value: string, label: string): string {
  const path = boundedText(value, 1_024, label);
  if (path.startsWith("/") || hasControlCharacter(path) || path.split(/[\\/]/).includes("..")) {
    invalid(`${label} must stay relative to the workspace`);
  }
  return path;
}

function routePath(value: string): string {
  const path = boundedText(value, 256, "projection path");
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    invalid("projection path must be an absolute URL path without query or fragment");
  }
  return path;
}

function stableName(value: string, label: string): string {
  const name = boundedText(value, 128, label);
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(name)) {
    invalid(`${label} contains unsupported characters`);
  }
  return name;
}

function sha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    invalid(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(`${label} must be a positive safe integer`);
  }
}

function oneOf<T extends string>(value: T, values: readonly T[], label: string): T {
  if (!values.includes(value)) {
    invalid(`unsupported ${label}`);
  }
  return value;
}

function invalid(message: string): never {
  throw new DeploymentAuthoringError("invalid_deployment", message);
}
