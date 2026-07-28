import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  ForeignA2ADurableSession,
  createHttpJsonForeignA2AClient,
  createSecureForeignA2AHttpTransport,
  discoverForeignA2AAgent,
  prepareForeignA2AInvocation,
  type ForeignA2AGuarantee,
} from "../index.ts";

const cardUrl = process.env["A2A_INTEROP_CARD_URL"];
const skillId = process.env["A2A_INTEROP_SKILL_ID"];
const token = process.env["A2A_INTEROP_BEARER_TOKEN"];
const enabled = Boolean(cardUrl && skillId);

describe("third-party A2A interoperability", () => {
  it.skipIf(!enabled)(
    "normalizes a live non-Sweatpants A2A task or direct message",
    async () => {
      const authorization = token
        ? () => ({ headers: { authorization: `Bearer ${token}` } })
        : undefined;
      const discovery = await discoverForeignA2AAgent({
        source: { cardUrl: cardUrl! },
        skillId: skillId!,
        principalId: "third-party-interop",
        supportedAuthSchemes: token ? ["bearer", "oauth2"] : [],
        minimumGuarantee: (process.env["A2A_INTEROP_MINIMUM_GUARANTEE"] ??
          "task_handle_only") as ForeignA2AGuarantee,
        ...(authorization ? { authorization } : {}),
      });
      const pin = prepareForeignA2AInvocation({
        discovery,
        derivationKey:
          process.env["A2A_INTEROP_DERIVATION_KEY"] ??
          "third-party-interop-derivation-key-at-least-32-bytes",
        localIdentity: { run: Date.now(), ...(skillId ? { skillId } : {}) },
        principalId: "third-party-interop",
      });
      const client = createHttpJsonForeignA2AClient({
        transport: createSecureForeignA2AHttpTransport({
          cardOrigin: discovery.cardOrigin,
          ...(authorization
            ? {
                authorization: async () => authorization()?.headers,
              }
            : {}),
        }),
      });
      const transition = await run(() =>
        new ForeignA2ADurableSession({ client }).start({
          pin,
          message: {
            messageId: pin.initialMessageId,
            role: "user",
            parts: [
              {
                text:
                  process.env["A2A_INTEROP_PROMPT"] ??
                  "Reply briefly to confirm A2A task interoperability.",
              },
            ],
          },
          maxDispatchAttempts: 1,
        }),
      );
      expect(["progress", "interruption", "terminal", "indeterminate"]).toContain(
        transition.event.type,
      );
    },
    60_000,
  );
});
