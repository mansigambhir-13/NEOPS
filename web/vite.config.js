import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api → the control plane so the browser talks same-origin.
// Set NEOP_API_ORIGIN to the FastAPI control plane (default localhost:8000).
const apiOrigin = process.env.NEOP_API_ORIGIN || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
