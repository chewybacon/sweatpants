import { run } from "effection";
import { waitForSnapshot } from "../../support/client.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  createPrimitiveChatApp,
  type PrimitiveChatOptions,
} from "@sweatpants/agent-host/primitive";
import { serve } from "@sweatpants/agent-host/node";
import { createChatClient } from "@sweatpants/react-chat";
import { approveRecord } from "../../fixtures/approve-record.ts";

type Driver = PrimitiveChatOptions["model"]["driver"];
const textResponse = {
  message: { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello" }] },
  source: null,
  usage: null,
  stopReason: "stop",
  responseId: null,
  errorMessage: null,
};

function options(database: string, sample: Driver["sample"]): PrimitiveChatOptions {
  return {
    database,
    program: { id: "boundary-chat", version: "1", digest: "boundary-chat-v1" },
    authorize: () => true,
    tools: [],
    effects: {},
    model: {
      identity: "fixture-model",
      model: {
        id: "fixture",
        name: "Fixture",
        api: "fixture",
        provider: "fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 100,
      },
      driver: {
        sample,
        *stream(request) {
          return {
            *[Symbol.iterator]() {
              return {
                *next() {
                  return { done: true as const, value: yield* sample(request) };
                },
              };
            },
          };
        },
      },
    },
  };
}

function send(
  origin: string,
  conversationId: string,
  messageId: string,
  basisRevision: string | null,
) {
  return fetch(`${origin}/assistant/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      clientId: "acceptance",
      userMessage: { id: messageId, role: "user", content: "Hello" },
      command: {
        type: "send-message",
        commandId: randomUUID(),
        messageId,
        basisRevision,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    }),
  });
}

it("rejects colliding message IDs before admission and leaves reconnect and valid sends usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primitive-boundaries-"));
  const database = join(directory, "chat.sqlite");
  const config = options(database, function* () {
    return textResponse;
  });
  let server = await serve(createPrimitiveChatApp(config), { port: 0 });
  try {
    const client = createChatClient({
      threadId: "a",
      transport: { http: { api: `${server.origin}/assistant/chat` } },
    });
    try {
      await client.initialized;
      expect((await send(server.origin, "a", "same", null)).status).toBe(200);
      await client.reconnect();
      const snapshot = client.getSnapshot();
      const revision = snapshot.authority!.revision;
      const assistantId = snapshot.messages.find((message) => message.role === "assistant")!.id;
      for (const collision of ["same", assistantId]) {
        const rejected = await send(server.origin, "a", collision, revision);
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toEqual({ error: "message_id_conflict" });
      }
      const db = new DatabaseSync(database);
      try {
        expect(db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get()!.n).toBe(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM chat_commands").get()!.n).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await client.close();
    }
    await server.close();
    server = await serve(createPrimitiveChatApp(config), { port: 0 });
    const resumed = createChatClient({
      threadId: "a",
      transport: { http: { api: `${server.origin}/assistant/chat` } },
    });
    try {
      await resumed.initialized;
      await resumed.reconnect();
      expect(resumed.getSnapshot().authority?.state).toBe("idle");
      await resumed.sendMessage("Valid next turn");
      expect(resumed.getSnapshot().error).toBeNull();
      expect(resumed.getSnapshot().authority?.state).toBe("idle");
      expect((await send(server.origin, "b", "new", null)).status).toBe(200);
    } finally {
      await resumed.close();
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves a provider failure through the real public client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primitive-provider-"));
  const server = await serve(
    createPrimitiveChatApp(
      options(join(directory, "chat.sqlite"), function* () {
        throw new Error("provider offline");
      }),
    ),
    { port: 0 },
  );
  const client = createChatClient({
    threadId: "provider",
    transport: { http: { api: `${server.origin}/assistant/chat` } },
  });
  try {
    await client.initialized;
    await client.sendMessage("Hello");
    expect(client.getSnapshot().error).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "[EXECUTION_FAILED] provider offline",
    });
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports unsafe recovery through the host without redispatch or false completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "primitive-unsafe-"));
  let effects = 0;
  let samples = 0;
  const config = options(join(directory, "chat.sqlite"), function* () {
    samples++;
    return {
      ...textResponse,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCall: {
              id: "record",
              thoughtSignature: null,
              name: "approve_record",
              input: { topic: "unsafe" },
            },
          },
        ],
      },
    };
  });
  config.tools = [approveRecord];
  config.effects = {
    "approve_record.record": function* () {
      effects++;
      // External work happened, but the handler never supplied an outcome to accept.
      throw new Error("connection lost after record");
    },
  };
  let server = await serve(createPrimitiveChatApp(config), { port: 0 });
  try {
    const failed = await send(server.origin, "unsafe", "first", null);
    expect(failed.status).toBe(200);
    expect(await failed.text()).toContain("OUTCOME_UNKNOWN");
    await server.close();
    server = await serve(createPrimitiveChatApp(config), { port: 0 });
    const client = createChatClient({
      threadId: "unsafe",
      transport: { http: { api: `${server.origin}/assistant/chat` } },
    });
    try {
      await client.initialized;
      await run(() => waitForSnapshot(client, (snapshot) => snapshot.error !== null));
      expect(client.getSnapshot().error).toMatchObject({
        code: "OUTCOME_UNKNOWN",
        message: "[OUTCOME_UNKNOWN] outcome_unknown: outcome_unknown: exchange 1 may have happened",
      });
      const authority = client.getSnapshot().authority!;
      const stop = {
        conversationId: "unsafe",
        clientId: "acceptance",
        command: {
          type: "interrupt-turn",
          commandId: randomUUID(),
          basisRevision: authority.revision,
          logicalTurnId: authority.activeLogicalTurnId,
          executionId: authority.activeExecutionId,
          reason: "Stop unsafe work",
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      };
      for (let retry = 0; retry < 2; retry++) {
        const response = await fetch(`${server.origin}/assistant/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(stop),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: "outcome_unknown: cannot settle an unaccepted unsafe attempt",
        });
      }
      await client.reconnect();
      expect(client.getSnapshot().authority?.state).toBe("running");
      expect(client.getSnapshot().error).toMatchObject({ code: "OUTCOME_UNKNOWN" });
      const db = new DatabaseSync(config.database);
      try {
        expect(db.prepare("SELECT status FROM executions").get()!.status).toBe("interrupting");
        expect(db.prepare("SELECT COUNT(*) AS n FROM chat_commands").get()!.n).toBe(2);
      } finally {
        db.close();
      }
      expect(effects).toBe(1);
      expect(samples).toBe(1);
      const blocked = await send(server.origin, "other", "new", null);
      expect(await blocked.json()).toEqual({ error: "execution_busy" });
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
