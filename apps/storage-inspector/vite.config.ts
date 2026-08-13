import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createStorageInspectorApi } from "./src/server/storage-api.ts";

function storageInspectorApi(): Plugin {
  return {
    name: "storage-inspector-api",
    async configureServer(server) {
      const databasePath = process.env["SWEATPANTS_STORAGE_SPINE_PATH"];
      const api = await createStorageInspectorApi(databasePath);
      server.middlewares.use((request, response, next) => {
        api.handle(request, response, next);
      });
      server.httpServer?.once("close", () => {
        void api.close();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), storageInspectorApi()],
  server: { port: 8_120 },
});
