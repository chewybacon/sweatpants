/**
 * Book Flight Tool Module
 *
 * Exports the MCP tool and plugin for flight booking functionality.
 *
 * Usage:
 * ```typescript
 * import { bookFlightTool, bookFlightPlugin } from './tools/book-flight'
 *
 * // Register the plugin with your chat handler
 * const plugins = createPluginRegistry()
 * plugins.register(bookFlightPlugin)
 * ```
 */

// Tool definition
export { bookFlightTool } from "./tool";
export type { BookFlightResult } from "./tool";
export type { Flight, SeatMap } from "../schemas/book-flight.ts";

// Plugin with elicit handlers
export { bookFlightPlugin } from "./plugin";

// Components (for testing or custom usage)
export { FlightList } from "./components/FlightList";
export { SeatPicker } from "./components/SeatPicker";
