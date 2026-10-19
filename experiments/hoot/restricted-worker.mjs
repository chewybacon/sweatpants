import { Scheme } from "./reflect-restricted.mjs";
import { restrictionScenarios } from "./restriction-scenarios.mjs";
export default {
  async fetch() {
    try {
      return Response.json(await restrictionScenarios(() => Scheme.load_main("restricted.wasm")));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
