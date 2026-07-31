import { createContext } from "effection";
import type { Context } from "effection";
export const BaseUrlContext: Context<string> = createContext<string>("chat:baseUrl", "/api/chat");
