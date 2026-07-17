import {
  createStandardA2AHost,
  programDriverSchemaRegistry,
  serveAgent,
  standardA2A,
} from "@sweatpants/framework/server";
import {
  createFileProgramDriverJournalStore,
  createFileStandardA2ATaskDirectory,
  startAgentHarness,
} from "@sweatpants/framework/server/testing";
import { createCapabilityKeyring } from "@sweatpants/session-contract";
import { cardAgent, cardChat } from "./agent.ts";
import { realModelRegistration, selectedModel } from "./model.ts";
import { drawCardsRegistration } from "./pick-card.ts";
import { scriptedModelRegistration } from "./scripted-model.ts";

const port = Number(process.env["YO_A2A_PORT"] ?? "45681");
const principal = { principalId: "yo-a2a-local-user" } as const;
const modelMode = process.env["YO_A2A_MODEL_MODE"] ?? "real";
const bearerToken = process.env["YO_A2A_BEARER_TOKEN"];
const modelRegistration =
  modelMode === "scripted" ? scriptedModelRegistration : realModelRegistration;
const stateDirectory = process.env["YO_A2A_STATE_DIR"];
const persistentJournal = stateDirectory
  ? createFileProgramDriverJournalStore({
      directory: `${stateDirectory}/journals`,
      keyring: createCapabilityKeyring("yo-a2a", [
        {
          keyId: "yo-a2a",
          secret: process.env["YO_A2A_CAPABILITY_SECRET"] ?? "yo-a2a-stable-capability-secret-key",
        },
      ]),
      schemaRegistry: programDriverSchemaRegistry(cardChat.schemaCatalog),
    })
  : undefined;
const persistentTaskDirectory = stateDirectory
  ? createFileStandardA2ATaskDirectory(`${stateDirectory}/task-directory.json`)
  : undefined;
const served = serveAgent(
  cardAgent,
  standardA2A({
    deployment: {
      interfaceUrl: `http://127.0.0.1:${port}/a2a`,
      insecureLoopbackDevelopment: true,
      ...(bearerToken
        ? {
            securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
            securityRequirements: [{ bearer: [] }],
          }
        : {}),
    },
    handlers: [modelRegistration, drawCardsRegistration],
    capabilityBindings: {},
    host: createStandardA2AHost({
      ...(persistentJournal ? { journalStore: persistentJournal } : {}),
      ...(persistentTaskDirectory ? { taskDirectory: persistentTaskDirectory } : {}),
      *authenticate(request) {
        return bearerToken && request.headers.get("authorization") !== `Bearer ${bearerToken}`
          ? undefined
          : principal;
      },
      *authorize() {
        return true;
      },
    }),
  }),
);
const harness = await startAgentHarness({
  agent: served,
  port,
  ...(bearerToken ? { discoveryHeaders: { authorization: `Bearer ${bearerToken}` } } : {}),
  evidenceControl: {
    token: process.env["YO_A2A_EVIDENCE_TOKEN"] ?? "yo-a2a-evidence",
    context: principal,
  },
  ...(persistentJournal ? { checkpoint: () => persistentJournal.checkpoint() } : {}),
});
console.log(
  JSON.stringify({
    event: "yo-a2a-ready",
    model: modelMode === "scripted" ? { provider: "scripted", id: "yo-a2a-ci" } : selectedModel,
    cardUrl: harness.cardUrl,
    interfaceUrl: harness.interfaceUrl,
    example: "Draw 3 cards",
  }),
);
async function shutdown(): Promise<void> {
  await harness.stop();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
