import { unplugin as stylex } from "@stylexjs/unplugin";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [stylex.vite({ useCSSLayers: true }), tanstackStart(), react()],
});
