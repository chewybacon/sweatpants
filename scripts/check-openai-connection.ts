async function main() {
  /** Validate the explicitly selected OpenAI endpoint without printing credentials. */
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = process.env["DEFAULT_CHAT_MODEL_ID"];
  if (!apiKey || !model) {
    throw new Error("OpenAI live checks require OPENAI_API_KEY and DEFAULT_CHAT_MODEL_ID");
  }
  const baseUrl = process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`OpenAI model preflight failed: HTTP ${response.status}`);
  }
  const catalog: { data?: { id: string }[] } = await response.json();
  if (!catalog.data?.some((item) => item.id === model)) {
    throw new Error(`Configured OpenAI endpoint does not advertise model ${model}`);
  }
  console.log(`OpenAI connection ready for ${model}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
