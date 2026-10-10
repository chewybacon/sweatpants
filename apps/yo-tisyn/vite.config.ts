import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { clientContractPlugin } from "@sweatpants/vite-plugin";
export default defineConfig({
  plugins: [clientContractPlugin(), react()],
  server: { proxy: { "/api/chat": "http://127.0.0.1:8102" } },
});
