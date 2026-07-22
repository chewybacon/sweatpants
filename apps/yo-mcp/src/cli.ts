import { allTools } from "./tools/index.js";
import { startYoMcpServer } from "./server.js";

const SERVER_NAME = "yo-mcp";
const SERVER_VERSION = "0.1.0";
const PORT = Number.parseInt(process.env["PORT"] || "3001", 10);

async function main() {
  console.error(`Starting ${SERVER_NAME} v${SERVER_VERSION}...`);
  console.error(`Registered ${allTools.length} tools:`);
  for (const tool of allTools) {
    console.error(`  - ${tool.name}: ${tool.description}`);
  }

  const server = await startYoMcpServer(PORT);
  console.error(`\nHTTP server running on ${server.origin}`);
  console.error("\nTest with:");
  console.error(`  curl -X POST http://localhost:${PORT}/mcp \\`);
  console.error('    -H "Content-Type: application/json" \\');
  console.error(
    `    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"}}}'`,
  );

  process.on("SIGINT", async () => {
    console.error("\nShutting down...");
    await server.close();
    process.exit(0);
  });
}

void main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});
