import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ["@primuslabs/zktls-js-sdk"] },
  define: { global: "globalThis" },
  server: { port: 5173 },
  preview: { port: 4173 }
});
