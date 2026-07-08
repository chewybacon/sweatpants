/**
 * Vitest globalSetup for the outside-in tier (design Q4).
 *
 * Boots the real app server ONCE for the run when Tier B is requested
 * (`OUTSIDE_IN_TIER_B=1`), honoring `reuseExistingServer` via
 * `OUTSIDE_IN_REUSE_SERVER=1`. Exposes the base URL through
 * `OUTSIDE_IN_SERVER_URL` for `tier-b` bindings and tears the server down after
 * the run. No-op for Tier-A-only runs so the fast loop stays server-free.
 */
import { requireCopilotAuth } from "./lib/auth.ts";
import { bootServer } from "./lib/server-fixture.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env["RUN_LIVE"] === "1") {
    requireCopilotAuth();
  }

  if (process.env["OUTSIDE_IN_TIER_B"] !== "1") {
    return async () => {};
  }
  if (process.env["OUTSIDE_IN_SERVER_URL"]) {
    // Caller pointed us at an already-running server; nothing to own.
    return async () => {};
  }

  const handle = await bootServer({
    reuseExisting: process.env["OUTSIDE_IN_REUSE_SERVER"] === "1",
  });
  process.env["OUTSIDE_IN_SERVER_URL"] = handle.url;
  // eslint-disable-next-line no-console
  console.info(
    `[outside-in:tier-b] server ${handle.reused ? "reused" : "booted"} at ${handle.url}`,
  );

  return async () => {
    delete process.env["OUTSIDE_IN_SERVER_URL"];
    await handle.close();
  };
}
