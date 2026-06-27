import { defineConfig } from "vite";

export default defineConfig({
  // Cloudflare Pages serves from the build output directory.
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
  },
  // SharedArrayBuffer / cross-origin isolation is NOT enabled here on purpose:
  // it would require COOP/COEP headers and break third-party fetch (httpbin).
  // The RAM benchmark therefore avoids SharedArrayBuffer.
  server: {
    port: 5173,
    open: true,
  },
});
