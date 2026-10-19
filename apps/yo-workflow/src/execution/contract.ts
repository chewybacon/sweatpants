import { z } from "zod";
import { executionInspectionSchema } from "./inspection.ts";

export const languageSchema = z.object({
  id: z.string(),
  label: z.string(),
  runtime: z.string(),
  developerLanguage: z.string(),
});
export const languageCatalogSchema = z.object({ languages: z.array(languageSchema) });
export type WorkflowLanguage = z.infer<typeof languageSchema>;
export const executionViewSchema = z.object({
  language: languageSchema,
  id: z.string(),
  revision: z.number(),
  status: z.string(),
  result: z.json().nullable(),
  inspection: z
    .object({
      execution: executionInspectionSchema,
      mode: z.string(),
      site: z.string().nullable(),
      steps: z.number().nullable(),
      snapshotBytes: z.number(),
      cancellationRequested: z.boolean(),
      currentEnvironment: z.number().nullable(),
      calls: z.array(z.string()),
      frames: z.array(z.object({ index: z.number(), kind: z.string(), detail: z.string() })),
      environments: z.array(
        z.object({
          id: z.number(),
          parent: z.number().nullable(),
          bindings: z.array(z.object({ name: z.string(), value: z.string() })),
        }),
      ),
      cleanups: z.array(
        z.object({
          kind: z.string(),
          scope: z.string().nullable(),
          remaining: z.array(z.string()),
          completion: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  checkpoint: z.json().nullable(),
  restoration: z
    .object({
      stateUnchanged: z.literal(true),
      stepsBefore: z.number().nullable(),
      stepsAfter: z.number().nullable(),
    })
    .nullable(),
  pending: z.object({ key: z.string(), message: z.string(), pullId: z.string() }).nullable(),
  outbox: z.array(
    z.object({
      announcementId: z.string(),
      status: z.string(),
      title: z.string(),
      recipient: z.string(),
    }),
  ),
  trace: z.array(
    z.object({
      sequence: z.number(),
      at: z.string(),
      kind: z.string(),
      durationMs: z.number().optional(),
      data: z.json().optional(),
    }),
  ),
  developerSource: z.string(),
  programSource: z.string(),
});
export type ExecutionView = z.infer<typeof executionViewSchema>;
