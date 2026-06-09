import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxy = {
  "/api": {
    target: process.env["VITE_API_PROXY"] ?? "http://127.0.0.1:8787",
    changeOrigin: true,
    ws: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    proxy: apiProxy,
  },
  // `vite preview` serves the production build (dist/) for parity profiling and
  // single-origin local runs; mirror the dev proxy so the same relative /api and
  // /api/world/stream (WS) reach the game server.
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: false,
    allowedHosts: true,
    proxy: apiProxy,
  },
});
