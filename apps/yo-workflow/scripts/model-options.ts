import { reasoningLevel } from "../src/server/model-settings.ts";

export function modelOptions(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  let provider = env.DEFAULT_CHAT_MODEL_PROVIDER ?? "opencode";
  let model = env.DEFAULT_CHAT_MODEL_ID;
  let thinking = env.DEFAULT_CHAT_MODEL_THINKING;
  let port = "8103";
  let listModels = false;
  let help = false;
  let explicitProvider = false;
  let explicitModel = false;
  const astroArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      continue;
    }
    if (arg === "--list-models") {
      listModels = true;
      continue;
    }
    if (arg === "--help") {
      help = true;
      continue;
    }
    const match = /^(--provider|--model|--thinking|--port)(?:=(.*))?$/u.exec(arg);
    if (!match) {
      astroArgs.push(arg);
      continue;
    }
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith("--")) {
      throw new Error(`${match[1]} requires a value`);
    }
    if (match[1] === "--provider") {
      provider = value;
      explicitProvider = true;
    }
    if (match[1] === "--model") {
      model = value;
      explicitModel = true;
    }
    if (match[1] === "--port") {
      port = value;
    }
    if (match[1] === "--thinking") {
      thinking = value;
    }
  }
  if (explicitProvider && !explicitModel && provider !== env.DEFAULT_CHAT_MODEL_PROVIDER) {
    model = undefined;
  }
  if (provider !== "opencode" && provider !== "github-copilot") {
    throw new Error(
      `Unsupported yo-workflow provider: ${provider}. Use opencode or github-copilot.`,
    );
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return {
    port,
    provider,
    model: model ?? (provider === "opencode" ? "claude-haiku-5-5" : "gpt-6.1-sol"),
    thinking: reasoningLevel(thinking),
    listModels,
    help,
    astroArgs,
  };
}
