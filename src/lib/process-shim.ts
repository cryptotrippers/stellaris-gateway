/**
 * Minimal browser `process` shim.
 *
 * Lucid Evolution pulls in `readable-stream`, which reads `process.version`
 * and `process.nextTick` at module scope. We used to get this from
 * `vite-plugin-node-polyfills`' `globals.process` option, but that injects a
 * module-level `import process from "…shim"` into every dependency — including
 * TanStack Start's client RPC module, where it shadows the build-time
 * `process.env.TSS_SERVER_FN_BASE` define and makes every server-function call
 * hit `/undefined<id>` (HTTP 500).
 *
 * Installing the global ourselves keeps Lucid happy without rewriting any
 * dependency's `process.env.*` references.
 */

const g = globalThis as unknown as { process?: unknown };

if (typeof globalThis !== "undefined" && !g.process) {
  g.process = {
    env: {} as Record<string, string | undefined>,
    version: "v20.0.0",
    versions: { node: "20.0.0" },
    platform: "browser",
    browser: true,
    nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) => {
      queueMicrotask(() => cb(...args));
    },
    argv: [] as string[],
    cwd: () => "/",
  };
}

export {};

