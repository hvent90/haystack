import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env["VITE_API_PROXY"] ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
