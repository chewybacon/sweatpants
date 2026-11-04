import type { QuestionContext, QuestionAnswer } from "@sweatpan.ts/chat-client";
import type { ResolutionGrant } from "@sweatpan.ts/durable";
import type { z } from "zod";
import type { flightResult, itineraryResult } from "./flight-chat.ts";
import type { ConversationPart } from "@sweatpan.ts/chat-client";
import type { ChatClient } from "@sweatpan.ts/chat-client";

export type FlightQuestionContract =
  | {
      readonly kind: "flight";
      readonly context: {
        readonly choices: readonly { readonly id: string; readonly airline: string }[];
      };
      readonly response: { readonly flight: "flight-1" | "flight-2" };
    }
  | {
      readonly kind: "seat";
      readonly context: { readonly flight: string; readonly seats: readonly string[] };
      readonly response: { readonly seat: "2A" | "2B" };
    }
  | {
      readonly kind: "save";
      readonly context: { readonly flight: string; readonly seat: string };
      readonly response: { readonly confirm: true };
    };
export type FlightQuestion = QuestionContext<FlightQuestionContract>;
export interface FlightTarget {
  readonly id: string;
  readonly execution: string;
  readonly grant: ResolutionGrant;
}
export type FlightCommand = QuestionAnswer<FlightQuestionContract, FlightTarget>;
export type FlightOutput = z.infer<typeof flightResult> | z.infer<typeof itineraryResult>;
export type FlightPart = ConversationPart<FlightQuestionContract, FlightOutput>;
export interface FlightView {
  readonly status: "running" | "completed" | "cancelled";
  readonly messages: readonly FlightPart[];
  readonly questions: readonly (FlightTarget & { readonly question: FlightQuestion })[];
}
export interface FlightReceipt {
  readonly receipt: string;
  readonly duplicate: boolean;
}
export type FlightClient = ChatClient<FlightView, FlightCommand, FlightReceipt>;
