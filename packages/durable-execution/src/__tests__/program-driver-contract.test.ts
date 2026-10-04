import { describe, expect, it } from "vitest";
import type { Json } from "@sweatpants/foundation";

import { programRouteDriverKind } from "../program-driver-contract.ts";

describe("program route discrimination", () => {
  it("returns the driver fixed by the placement route", () => {
    expect(programRouteDriverKind({ driverKind: "worker", profile: "isolated" })).toBe("worker");
  });

  it.each<Json>([null, {}, { kind: "worker" }, { driverKind: "" }])(
    "rejects a route without a bound driver kind: %j",
    (route) => {
      expect(() => programRouteDriverKind(route)).toThrow(/Program route/);
    },
  );
});
