import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The daemon the dev server proxies `/api/*` to (no CORS needed). */
const daemon = process.env.HEARTWOOD_DAEMON_URL ?? "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: daemon, rewrite: (p) => p.replace(/^\/api/, ""), changeOrigin: true },
    },
  },
});
