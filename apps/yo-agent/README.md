# yo-agent

An in-process terminal proof of concept for the Sweatpants chat stack.

Yo Agent runs the host, model provider, durable streams, local tool runtime, headless Chat Client, and
Ink UI in one Node process. It uses no network server: Chat Client's HTTP transport receives an injected
`fetch` that calls the handler directly.

Ink uses React's reconciler, but this application deliberately does not use `@sweatpants/react-chat` or
a DOM. It demonstrates that the framework-neutral client projection and terminal-specific frame
processors can support another frontend.

## Running

```bash
cd apps/yo-agent
pnpm dev
```

An interactive terminal and a configured model-provider credential are required. Model selection uses
`DEFAULT_CHAT_MODEL_PROVIDER` and `DEFAULT_CHAT_MODEL_ID`; provider-specific resolution remains behind
`@sweatpants/model-provider-pi-ai`.

## Architecture

```text
Ink UI
  → thin useSyncExternalStore adapter
  → @sweatpants/chat-client (direct, unpaced presentation fallback)
  → injected in-process fetch transport
  → createChatHandler
  → in-memory durable streams
  → local model and worker-backed tools
```

Tool modules are loaded through Vite and hot-reload in the in-process handler. Terminal Markdown and
code processors are supplied as Chat Client pipeline configuration; the UI renders frames already
present on recursive message parts. The app-local terminal interaction runtime binds the `ask_user`
tool to terminal text input without importing React Chat.

## Key bindings

| Key        | Action                                              |
| ---------- | --------------------------------------------------- |
| Enter      | Send a message or answer the active terminal prompt |
| `/decline` | Decline the active prompt                           |
| `/cancel`  | Cancel the active prompt                            |
| Ctrl+C     | Exit                                                |

## Scope

This proof of concept covers text, reasoning, tool activity, nested messages, and one deliberately
narrow typed terminal elicitation binding. It does not attempt to generate terminal forms from arbitrary
portable schemas.
