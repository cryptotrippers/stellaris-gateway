// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";
import wasm from "vite-plugin-wasm";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// High-value pages to pre-render at build time for indexing + fast TTFB.
// Marketplace detail pages are added dynamically from mock data below.
const STATIC_PRERENDER_PATHS = [
  "/",
  "/marketplace",
  "/yield",
  "/governance",
  "/governance?tab=overview",
  "/governance?tab=proposals",
  "/governance?tab=vaults",
  "/governance?tab=delegates",
  "/governance?tab=signals",
  "/stewardship",
  "/security",
  "/developers",
  "/upgrade",
];

// Keep in sync with ASSETS in src/lib/mock-data.ts
const MARKETPLACE_IDS = ["sfm-01", "ceb-02", "cc-03", "re-04", "inf-05", "ceb-06"];

const PRERENDER_PATHS = [
  ...STATIC_PRERENDER_PATHS,
  ...MARKETPLACE_IDS.map((id) => `/marketplace/${id}`),
];

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    prerender: {
      enabled: true,
      concurrency: 4,
      failOnError: false,
    },
    pages: PRERENDER_PATHS.map((path) => ({
      path,
      prerender: { enabled: true, crawlLinks: false },
    })),
  },
  vite: {
    // Lucid Evolution uses top-level await, so raise the browser baseline.
    build: { target: "es2022" },
    esbuild: { target: "es2022" },
    optimizeDeps: { esbuildOptions: { target: "es2022" } },
    plugins: [
      mcpPlugin(),
      wasm(),
      nodePolyfills({
        include: ["events", "buffer", "stream", "util"],
        // `process` must be shimmed: Lucid pulls in readable-stream, which reads
        // `process.version.slice(...)` at module scope and crashes without it.
        globals: { Buffer: true, global: true, process: true },
      }),
    ],
  },
});
