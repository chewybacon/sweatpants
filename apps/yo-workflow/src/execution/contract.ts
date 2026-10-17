import { z } from "zod";

export const executionViewSchema = z.object({
  id: z.string(),
  revision: z.number(),
  status: z.string(),
  result: z.json().nullable(),
  inspection: z
    .object({
      mode: z.string(),
      site: z.string().nullable(),
      steps: z.number(),
      snapshotBytes: z.number(),
      cancellationRequested: z.boolean(),
      currentEnvironment: z.number(),
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
  restoration: z.object({ stepsBefore: z.number(), stepsAfter: z.number() }).nullable(),
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
  schemeSource: z.string(),
});
export type ExecutionView = z.infer<typeof executionViewSchema>;
