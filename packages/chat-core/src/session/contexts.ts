import { createContext } from "effection";
import type { Context } from "effection";
import type { Streamer } from "./options.ts";

export const BaseUrlContext: Context<string> = createContext<string>("chat:baseUrl", "/api/chat");

export const StreamerContext: Context<Streamer | undefined> = createContext<Streamer | undefined>(
  "chat:streamer",
  undefined,
);
