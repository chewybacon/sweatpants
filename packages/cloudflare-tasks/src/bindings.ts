// tsx may namespace module URLs; each shim instance reads the same process bindings.
// The CLI installs them before importing any task code.
export const env: unknown = Reflect.get(globalThis, Symbol.for("@sweatpants/cloudflare-tasks/env"));
