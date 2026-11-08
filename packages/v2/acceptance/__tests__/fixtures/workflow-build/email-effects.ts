import { z } from "zod";
import { defineEffect } from "@sweatpan.ts/core";

const declare = (key: string) =>
  defineEffect({
    key: `email.${key}`,
    context: z.object({ message: z.string() }),
    response: z.string(),
  });
export const draft = declare("draft");
export const approval = declare("approval");
export const send = declare("send");
export const remove = declare("remove");
