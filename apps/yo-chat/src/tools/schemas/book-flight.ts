import { z } from "zod";
export const FlightSchema = z.object({
  id: z.string(),
  airline: z.string(),
  flightNumber: z.string(),
  departure: z.string(),
  arrival: z.string(),
  duration: z.string(),
  price: z.number(),
});
export const SeatMapSchema = z.object({
  rows: z.number(),
  seatsPerRow: z.array(z.string()),
  taken: z.array(z.string()),
});
export type Flight = z.infer<typeof FlightSchema>;
export type SeatMap = z.infer<typeof SeatMapSchema>;
export const BookFlightParametersSchema = z.object({
  from: z.string().describe("Departure city or airport code"),
  destination: z.string().describe("Destination city or airport code"),
});

export const PickFlightResponseSchema = z.object({
  flightId: z.string().describe("Selected flight ID"),
});

export const PickFlightContextSchema = z.object({
  flights: z.array(FlightSchema),
});

export const PickSeatResponseSchema = z.object({
  row: z.number().describe("Selected row number"),
  seat: z.string().describe("Selected seat letter (A-F)"),
});

export const PickSeatContextSchema = z.object({
  seatMap: SeatMapSchema,
  flightInfo: z
    .object({
      airline: z.string(),
      flightNumber: z.string(),
    })
    .optional(),
});
