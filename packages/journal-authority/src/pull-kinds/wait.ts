import { sleep, type Operation } from "effection";
import { z } from "zod";
import { CrankError } from "@sweatpants/durable-execution";
import { PULL_KIND_WAIT } from "./kinds.ts";
import type { PullResolver } from "./registry.ts";
import { registerPullKind } from "./registry.ts";
import { recordKeySchema } from "./wire.ts";

export const waitDescriptorSchema = z.strictObject({
  kind: z.literal("wait"),
  key: recordKeySchema,
  notBefore: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
});

export function createWaitPullResolver(
  options: {
    readonly now?: () => number;
    readonly delay?: (durationMs: number) => Operation<void>;
  } = {},
): PullResolver {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((durationMs: number) => sleep(durationMs));
  return {
    kind: PULL_KIND_WAIT,
    audience: () => "scheduler",
    *perform(_ctx, descriptor) {
      const parsed = waitDescriptorSchema.safeParse(descriptor);
      if (!parsed.success) {
        throw new CrankError("invalid_descriptor", "Wait resolver received an invalid descriptor");
      }
      const target =
        parsed.data.notBefore === undefined
          ? now() + (parsed.data.durationMs ?? 0)
          : Date.parse(parsed.data.notBefore);
      if (!Number.isFinite(target)) {
        throw new CrankError("invalid_descriptor", "Wait deadline is invalid");
      }
      const remaining = target - now();
      if (remaining > 0) {
        yield* delay(remaining);
      }
      return { status: "ok", value: null };
    },
  };
}

registerPullKind({
  kind: PULL_KIND_WAIT,
  descriptorSchema: waitDescriptorSchema,
  journalLabel: (descriptor) => `wait(${(descriptor as { key: string }).key})`,
  resolutionAuthority: (descriptor, audience) => ({
    kind: "clock",
    audience,
    notBefore: descriptor.kind === "wait" ? (descriptor.notBefore ?? "") : "",
    capability: "",
  }),
});
