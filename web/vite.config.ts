import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const bridgeTarget = process.env.HERDR_WEB_BRIDGE ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
            return "react";
          }
          if (id.includes("node_modules/ghostty-web")) {
            return "terminal";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": bridgeTarget,
      "/ws": {
        target: bridgeTarget,
        ws: true,
      },
    },
  },
});
