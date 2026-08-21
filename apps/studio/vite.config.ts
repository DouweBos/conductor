import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const PORT = Number(process.env.STUDIO_PORT ?? 5273);

// COOP/COEP are required so the renderer can use WebCodecs' SharedArrayBuffer
// path when decoding the H.264 device stream from the conductor daemon.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  server: {
    port: PORT,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
    emptyOutDir: true,
  },
});
