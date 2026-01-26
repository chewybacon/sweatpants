import { createContext } from "effection";
import type { CorrelatedTransport } from "../transport/correlation.ts";

/**
 * Context for accessing the CorrelatedTransport.
 * 
 * Tools that don't have a local impl will use this context to route
 * their invocations through the transport to the Operative side.
 * 
 * @example
 * ```ts
 * // Principal side setup
 * function* principalMain(transport: PrincipalTransport) {
 *   const correlated = yield* createCorrelation(transport);
 *   yield* TransportContext.set(correlated);
 *   
 *   // Now tools without impl will route through transport
 *   const getLocation = yield* GetLocation();
 *   const location = yield* getLocation({ accuracy: "high" });
 * }
 * ```
 */
export const TransportContext = createContext<CorrelatedTransport>("sweatpants.transport");
