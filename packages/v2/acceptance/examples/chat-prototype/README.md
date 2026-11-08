# Retired chat prototype

Acceptance-only assembly retained when `apps/yo-chat-v2` was reset to a minimal TanStack Start base. It exercises SQLite conversation ownership, HTTP commands, streaming, Lua code tools, flight elicitation, React presentation and client-bound retries through public v2 APIs.

The `yo-chat-v2*.acceptance.test.ts(x)` filenames retain their historical names. They import this fixture and do not establish coverage for the new Start application. The Node listener fixture covers transport limits and joined shutdown; browser asset bundling belongs to the new framework app.

An uncertain composer submission captures its original client's send and refresh actions. Replacing the provider does not retarget that retry; the next new submission uses the replacement client.

No standalone server or browser bootstrap is retained here. Live-provider helpers are exercised with simulated peers by acceptance; no credentials are required.
