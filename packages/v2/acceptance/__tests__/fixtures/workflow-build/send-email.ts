import { z } from "zod";
import { defineTool } from "@sweatpan.ts/tools";
import { draft, approval, send, remove } from "./email-effects.js";

export const sendEmail = defineTool("sendEmail")
  .parameters(z.string())
  .capabilities({ draft, send, remove })
  .elicits({ approval })
  .execute(function* (input, ctx) {
    "use workflow";
    const draft = yield* ctx.capabilities.draft({ message: input });
    if (draft.ok) {
      const approval = yield* ctx.elicit("approval", { message: draft.value });
      if (approval.ok) {
        const sent = yield* ctx.capabilities.send({ message: draft.value });
        if (sent.ok) {
          return "sent:" + sent.value;
        } else {
          return "send-failed";
        }
      } else {
        const removed = yield* ctx.capabilities.remove({ message: draft.value });
        if (removed.ok) {
          return "declined:" + draft.value;
        } else {
          return "delete-failed";
        }
      }
    } else {
      return "draft-failed";
    }
  });
