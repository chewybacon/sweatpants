import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
  FileCredentialStore,
  YO_CHAT_AUTH_PROVIDERS,
  defaultModelForProvider,
  isYoChatAuthProvider,
  readStoredModelSelection,
  selectStoredModel,
  sweatpantsAuthFile,
  type YoChatAuthProvider,
} from "../packages/model-provider-pi-ai/src/auth.ts";

interface Arguments {
  readonly command: string;
  readonly provider?: YoChatAuthProvider;
  readonly model?: string;
  readonly format?: "env" | "json";
}

function usage(exitCode = 0): never {
  console.log(`Yo-chat model authentication

Usage:
  pnpm --filter @sweatpants/model-provider-pi-ai dev:auth [--provider <provider>]
  pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login --provider <provider> [--model <model>]
  pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:refresh [--provider <provider>]
  pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:logout --provider <provider>
  pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:use --provider <provider> [--model <model>]
  pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:selection [--format env|json]
  pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:providers

Providers:
  github-copilot  GitHub device OAuth
  openai-codex    ChatGPT browser or device-code OAuth
  opencode        OpenCode Zen API key

Credentials and the selected model are stored once at:
  ${sweatpantsAuthFile()}

The file is repository-local and covered by .gitignore. Set
YO_CHAT_MODEL_AUTH_FILE to use a different file. Environment variables remain
one-process overrides: DEFAULT_CHAT_MODEL_PROVIDER, DEFAULT_CHAT_MODEL_ID,
COPILOT_GITHUB_TOKEN, OPENCODE_API_KEY, and provider-native variables.
`);
  process.exit(exitCode);
}

function parseArguments(argv: readonly string[]): Arguments {
  const [command = "status", ...rest] = argv;
  let provider: YoChatAuthProvider | undefined;
  let model: string | undefined;
  let format: "env" | "json" | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index]!;
    const value = rest[index + 1];
    const named = option.match(/^--(provider|model|format)=(.+)$/u);
    const key = named?.[1] ?? option.slice(2);
    const raw = named?.[2] ?? value;
    if (!raw || !["provider", "model", "format"].includes(key)) {
      usage(1);
    }
    if (!named) {
      index += 1;
    }
    if (key === "provider") {
      if (!isYoChatAuthProvider(raw)) {
        console.error(`Unsupported provider ${raw}. Choose: ${YO_CHAT_AUTH_PROVIDERS.join(", ")}`);
        process.exit(1);
      }
      provider = raw;
    } else if (key === "model") {
      model = raw.trim();
      if (!model) {
        usage(1);
      }
    } else {
      if (raw !== "env" && raw !== "json") {
        usage(1);
      }
      format = raw;
    }
  }
  return {
    command,
    /* CONDITIONAL-SPREAD: Only supplied provider participates in the model-auth selection override. */
    ...(provider ? { provider } : {}),
    /* CONDITIONAL-SPREAD: Only supplied model participates in the model-auth selection override. */
    ...(model ? { model } : {}),
    /* CONDITIONAL-SPREAD: Only supplied format participates in the model-auth selection override. */
    ...(format ? { format } : {}),
  };
}

function selectedProvider(args: Arguments): YoChatAuthProvider {
  const selected = readStoredModelSelection();
  const environment = process.env["DEFAULT_CHAT_MODEL_PROVIDER"];
  const provider =
    args.provider ??
    (environment && isYoChatAuthProvider(environment) ? environment : undefined) ??
    selected?.provider;
  if (provider) {
    return provider;
  }
  console.error(
    "No selected provider. Run `pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login --provider <provider>` first.",
  );
  process.exit(1);
}

function selectedModel(args: Arguments, provider: YoChatAuthProvider): string {
  const selected = readStoredModelSelection();
  return (
    args.model ??
    (selected?.provider === provider ? selected.id : undefined) ??
    defaultModelForProvider(provider)
  );
}

function authType(provider: YoChatAuthProvider): "oauth" | "api_key" {
  return provider === "opencode" ? "api_key" : "oauth";
}

async function createModels() {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  return builtinModels({ credentials: new FileCredentialStore() });
}

function notify(event: {
  type: string;
  message?: string;
  url?: string;
  instructions?: string;
  verificationUri?: string;
  userCode?: string;
  expiresInSeconds?: number;
}): void {
  if (event.type === "device_code") {
    console.log(`Open: ${event.verificationUri}`);
    console.log(`Code: ${event.userCode}`);
    if (event.expiresInSeconds) {
      console.log(`Expires in: ${event.expiresInSeconds}s`);
    }
    return;
  }
  if (event.type === "auth_url") {
    console.log(`Open: ${event.url}`);
    if (event.instructions) {
      console.log(event.instructions);
    }
    return;
  }
  if (event.message) {
    console.log(event.message);
  }
}

async function login(args: Arguments): Promise<void> {
  if (!args.provider) {
    console.error("Login requires --provider.");
    process.exit(1);
  }
  const models = await createModels();
  const rl = createInterface({ input, output });
  try {
    await models.login(args.provider, authType(args.provider), {
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          console.log(prompt.options.map((option) => `${option.id}: ${option.label}`).join("\n"));
        }
        const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
        return await rl.question(`${prompt.message}${suffix}: `);
      },
      notify,
    });
  } finally {
    rl.close();
  }
  const model = selectedModel(args, args.provider);
  selectStoredModel({ provider: args.provider, id: model });
  removeLegacyGeneratedCopilotEnv();
  console.log(`Authenticated ${args.provider} and selected ${args.provider}/${model}`);
  await status({ ...args, provider: args.provider });
}

async function status(args: Arguments): Promise<void> {
  const selected = readStoredModelSelection();
  const providers = args.provider ? [args.provider] : [...YO_CHAT_AUTH_PROVIDERS];
  const models = await createModels();
  console.log(`auth file: ${sweatpantsAuthFile()}`);
  console.log(
    `selected: ${selected ? `${selected.provider}/${selected.id}` : "none (environment/default fallback)"}`,
  );
  let unavailable = false;
  for (const provider of providers) {
    const check = await models.checkAuth(provider);
    const active = selected?.provider === provider ? " (selected)" : "";
    if (!check) {
      console.log(`${provider}: not configured${active}`);
      if (args.provider || selected?.provider === provider) {
        unavailable = true;
      }
    } else {
      console.log(`${provider}: ${check.type} via ${check.source ?? "stored credential"}${active}`);
    }
  }
  if (unavailable) {
    process.exitCode = 1;
  }
}

async function refresh(args: Arguments): Promise<void> {
  const provider = selectedProvider(args);
  const result = await (await createModels()).getAuth(provider);
  if (!result) {
    console.error(
      `${provider} is not configured. Run \`pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:login --provider ${provider}\`.`,
    );
    process.exit(1);
  }
  console.log(`Authenticated ${provider} via ${result.source ?? "stored credential"}`);
}

async function logout(args: Arguments): Promise<void> {
  if (!args.provider) {
    console.error("Logout requires --provider.");
    process.exit(1);
  }
  await (await createModels()).logout(args.provider);
  console.log(`Removed ${args.provider} credentials from ${sweatpantsAuthFile()}`);
}

function use(args: Arguments): void {
  if (!args.provider) {
    console.error("Use requires --provider.");
    process.exit(1);
  }
  const model = selectedModel(args, args.provider);
  selectStoredModel({ provider: args.provider, id: model });
  removeLegacyGeneratedCopilotEnv();
  console.log(`Selected ${args.provider}/${model}`);
}

function selection(args: Arguments): void {
  const selected = readStoredModelSelection();
  if (!selected) {
    console.error(
      "No selected provider. Run `pnpm --filter @sweatpants/model-provider-pi-ai dev:auth:use --provider <provider>`.",
    );
    process.exit(1);
  }
  if (args.format === "json") {
    console.log(JSON.stringify(selected));
  } else {
    console.log(`DEFAULT_CHAT_MODEL_PROVIDER=${selected.provider}`);
    console.log(`DEFAULT_CHAT_MODEL_ID=${selected.id}`);
  }
}

function removeLegacyGeneratedCopilotEnv(): void {
  const target = resolve(fileURLToPath(new URL("../apps/yo-chat/.env.local", import.meta.url)));
  if (!existsSync(target)) {
    return;
  }
  const source = readFileSync(target, "utf8");
  if (!source.startsWith("# Generated by pnpm copilot:auth:sync")) {
    return;
  }
  const managed = /^(?:DEFAULT_CHAT_MODEL_PROVIDER|COPILOT_GITHUB_TOKEN|SWEATPANTS_AUTH_FILE)=/u;
  const retained = source
    .split(/\r?\n/u)
    .filter(
      (line) => !line.startsWith("# Generated by pnpm copilot:auth:sync") && !managed.test(line),
    )
    .join("\n")
    .trim();
  if (!retained) {
    rmSync(target);
  } else {
    writeFileSync(target, `${retained}\n`, { mode: 0o600 });
  }
  console.log(`Removed legacy Copilot settings from ${target}`);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  switch (args.command) {
    case "status":
    case "check":
      await status(args);
      return;
    case "login":
      await login(args);
      return;
    case "refresh":
      await refresh(args);
      return;
    case "logout":
      await logout(args);
      return;
    case "use":
      use(args);
      return;
    case "selection":
    case "env":
      selection(args);
      return;
    case "providers":
      for (const provider of YO_CHAT_AUTH_PROVIDERS) {
        console.log(`${provider}\tdefault model: ${defaultModelForProvider(provider)}`);
      }
      return;
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    default:
      console.error(`Unknown command ${args.command}`);
      usage(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
