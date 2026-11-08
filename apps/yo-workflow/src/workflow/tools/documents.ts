import { completeElicitExchange, documentEffect } from "@sweatpants/agent-sdk";
import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import {
  documentRefSchema,
  documentPatchSchema,
  documentResultSchema,
} from "@sweatpants/durable-execution";
import { z } from "zod";
import { exchangeSchema, projectExchange } from "../exchanges.ts";

export const documentCreate = createDurableTool("document_create", { version: "1" })
  .description(
    "Create a workflow-scoped JSON document. It survives pauses and reloads within this workflow. Returns its reference and revision. Maximum content size: 16 KiB.",
  )
  .parameters(z.object({ name: z.string().min(1).max(256), content: z.json() }))
  .output(documentResultSchema)
  .effects({ [documentEffect.name]: documentEffect })
  .execute(function* (input, ctx) {
    return yield* ctx.effect(documentEffect, { operation: "create", ...input });
  });

export const documentRead = createDurableTool("document_read", { version: "1" })
  .description(
    "Read a document in this workflow. Optionally include changes since a revision. A reset means render the full current content.",
  )
  .parameters(
    z.object({
      document: documentRefSchema,
      sinceRevision: z.number().int().nonnegative().optional(),
    }),
  )
  .output(documentResultSchema)
  .effects({ [documentEffect.name]: documentEffect })
  .execute(function* (input, ctx) {
    return yield* ctx.effect(documentEffect, {
      operation: "read",
      document: input.document,
      /* CONDITIONAL-SPREAD: Omit absent sinceRevision from workflow requests and execution events; explicit undefined is not a portable JSON value. */
      ...(input.sinceRevision === undefined ? {} : { sinceRevision: input.sinceRevision }),
    });
  });

export const documentEdit = createDurableTool("document_edit", { version: "1" })
  .description(
    'Edit a workflow document against expectedRevision. Patches use op "set" or "remove" and path arrays of property names or array index strings. set with path [] replaces the root. Conflicts return current state; inspect it before retrying.',
  )
  .parameters(
    z.object({
      document: documentRefSchema,
      expectedRevision: z.number().int().positive(),
      patches: z.array(documentPatchSchema).min(1).max(64),
    }),
  )
  .output(documentResultSchema)
  .effects({ [documentEffect.name]: documentEffect })
  .execute(function* (input, ctx) {
    return yield* ctx.effect(documentEffect, { operation: "edit", ...input });
  });

const choiceSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  disabled: z.boolean().optional(),
});

export const documentPresentationSchema = z.object({
  message: z.string(),
  choices: z.array(choiceSchema),
  layout: z.enum(["list", "grid"]),
  columns: z.number().int().min(1).max(8),
});

export const presentChoices = createDurableTool("present_choices", { version: "1" })
  .description(
    "Present a read-only workflow document with choices. Parks for a normal user response. The workflow must validate the selected choice and perform document edits itself. Pass sinceRevision from the previous presentation (not the latest edit) to highlight changes. Grid columns preserve spatial layout; include disabled choices for unavailable positions. Only enabled choice IDs are accepted. Pass the document reference returned by document_create (observation.current.document). An unavailable document returns action error with a diagnostic before asking the user.",
  )
  .parameters(
    z.object({
      document: documentRefSchema,
      sinceRevision: z.number().int().nonnegative().optional(),
      message: z.string().min(1).max(4096),
      choices: z
        .array(choiceSchema)
        .min(1)
        .max(64)
        .refine(
          (choices) => new Set(choices.map((choice) => choice.id)).size === choices.length,
          "Choice IDs must be unique",
        ),
      layout: z.enum(["list", "grid"]).default("list"),
      columns: z.number().int().min(1).max(8).default(3),
    }),
  )
  .output(
    z.union([
      z.object({
        action: z.literal("accept"),
        content: z.object({ id: z.string() }),
        exchange: exchangeSchema,
      }),
      z.object({ action: z.literal("decline") }),
      z.object({ action: z.literal("cancel") }),
      z.object({ action: z.literal("error"), diagnostic: z.object({ code: z.string() }) }),
    ]),
  )
  .elicits({
    choose: {
      response: z.object({ id: z.string() }),
      context: documentPresentationSchema,
      documents: { content: z.json() },
    },
  })
  .effects({ [documentEffect.name]: documentEffect })
  .execute(function* (input, ctx) {
    const document = yield* ctx.effect(documentEffect, {
      operation: "read",
      document: input.document,
      /* CONDITIONAL-SPREAD: Omit absent sinceRevision from workflow requests and execution events; explicit undefined is not a portable JSON value. */
      ...(input.sinceRevision === undefined ? {} : { sinceRevision: input.sinceRevision }),
    });
    if (document.status !== "ok") {
      return {
        action: "error" as const,
        diagnostic: { code: document.status === "error" ? document.code : "document_unavailable" },
      };
    }
    const exchangeId = yield* ctx.record(
      { key: "choices.exchange-id", retrySafety: { mode: "repeatable" } },
      function* (attempt) {
        return attempt.pullId;
      },
    );
    const response = yield* ctx.elicit("choose", {
      message: input.message,
      context: {
        message: input.message,
        choices: input.choices,
        layout: input.layout,
        columns: input.columns,
      },
      documents: {
        content: {
          ...input.document,
          /* CONDITIONAL-SPREAD: Omit absent sinceRevision from workflow requests and execution events; explicit undefined is not a portable JSON value. */
          ...(input.sinceRevision === undefined ? {} : { sinceRevision: input.sinceRevision }),
        },
      },
    });
    if (
      response.action === "accept" &&
      !input.choices.some((choice) => choice.id === response.content.id && !choice.disabled)
    ) {
      throw new Error("Response is not one of the presented choices");
    }
    const completed = yield* completeElicitExchange({
      key: "choose",
      message: input.message,
      context: null,
      exchangeId,
      responseSchema: z.object({ id: z.string() }),
      completion: response,
    });
    return completed.action === "accept"
      ? {
          action: "accept" as const,
          content: completed.content,
          exchange: projectExchange(completed.exchange),
        }
      : { action: completed.action };
  });

/** A terminal presentation is acknowledged by the renderer, not treated as a user choice. */
export const displayDocument = createDurableTool("display_document", { version: "1" })
  .description(
    "Display a read-only document and optional grid/list cells without asking for a human reply. The renderer acknowledges delivery automatically. Useful for final state or results. This does not send document contents to a model. sinceRevision is the last displayed revision, not the latest edit revision. An unavailable document returns status error with a diagnostic.",
  )
  .parameters(
    z.object({
      document: documentRefSchema,
      sinceRevision: z.number().int().nonnegative().optional(),
      message: z.string().min(1).max(4096),
      cells: z.array(choiceSchema).max(64).default([]),
      layout: z.enum(["list", "grid"]).default("list"),
      columns: z.number().int().min(1).max(8).default(3),
    }),
  )
  .output(
    z.union([
      z.object({ status: z.literal("displayed") }),
      z.object({ status: z.literal("error"), diagnostic: z.object({ code: z.string() }) }),
    ]),
  )
  .elicits({
    display: {
      response: z.object({}),
      context: documentPresentationSchema,
      documents: { content: z.json() },
    },
  })
  .effects({ [documentEffect.name]: documentEffect })
  .execute(function* (input, ctx) {
    const document = yield* ctx.effect(documentEffect, {
      operation: "read",
      document: input.document,
      /* CONDITIONAL-SPREAD: Omit absent sinceRevision from workflow requests and execution events; explicit undefined is not a portable JSON value. */
      ...(input.sinceRevision === undefined ? {} : { sinceRevision: input.sinceRevision }),
    });
    if (document.status !== "ok") {
      return {
        status: "error" as const,
        diagnostic: { code: document.status === "error" ? document.code : "document_unavailable" },
      };
    }
    const response = yield* ctx.elicit("display", {
      message: input.message,
      context: {
        message: input.message,
        choices: input.cells,
        layout: input.layout,
        columns: input.columns,
      },
      documents: {
        content: {
          ...input.document,
          /* CONDITIONAL-SPREAD: Omit absent sinceRevision from workflow requests and execution events; explicit undefined is not a portable JSON value. */
          ...(input.sinceRevision === undefined ? {} : { sinceRevision: input.sinceRevision }),
        },
      },
    });
    if (response.action !== "accept") {
      throw new Error("Document display was not acknowledged");
    }
    return { status: "displayed" as const };
  });
