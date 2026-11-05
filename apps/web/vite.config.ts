import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "esnext"
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.OPENCLAW_WEB_PORT ?? 5173),
    strictPort: true
  }
});
