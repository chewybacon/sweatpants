import type { FlightCommand, FlightPart, FlightView } from "./flight-view-contract.ts";

// A small application policy: each control chooses the first displayed option.
export function firstFlightAnswer(target: FlightView["questions"][number]): FlightCommand {
  switch (target.question.kind) {
    case "flight": {
      const flight = target.question.context.choices[0]?.id;
      if (flight !== "flight-1" && flight !== "flight-2") {
        throw new Error("Unsupported flight selection");
      }
      return { kind: "flight", target, value: { flight } };
    }
    case "seat": {
      const seat = target.question.context.seats[0];
      if (seat !== "2A" && seat !== "2B") {
        throw new Error("Unsupported seat selection");
      }
      return { kind: "seat", target, value: { seat } };
    }
    case "save":
      return { kind: "save", target, value: { confirm: true } };
  }
}
export function flightPartLabel(part: FlightPart): string {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "message") {
    return part.role;
  }
  if (part.type === "question") {
    if (part.state === "answered") {
      switch (part.kind) {
        case "flight":
          return `flight: answered (${part.response.flight})`;
        case "seat":
          return `seat: answered (${part.response.seat})`;
        case "save":
          return part.response.confirm ? "save: answered (confirmed)" : "save: answered";
      }
    }
    return `${part.kind}: ${part.state}`;
  }
  if (part.output && "itinerary" in part.output) {
    return `Saved itinerary: ${part.output.itinerary.id}`;
  }
  if (part.output && "flight" in part.output) {
    return `Booked flight: ${part.output.flight}, seat: ${part.output.seat}`;
  }
  return `${part.name}: ${part.state}`;
}
