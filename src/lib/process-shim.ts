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

type MinimalProcess = {
  env: Record<string, string | undefined>;
  version: string;
  versions: Record<string, string>;
  platform: string;
  browser: boolean;
  nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) => void;
  argv: string[];
  cwd: () => string;
};

declare global {
  // eslint-disable-next-line no-var
  var process: MinimalProcess | undefined;
}

if (typeof globalThis !== "undefined" && !globalThis.process) {
  globalThis.process = {
    env: {},
    version: "v20.0.0",
    versions: { node: "20.0.0" },
    platform: "browser",
    browser: true,
    nextTick: (cb, ...args) => {
      queueMicrotask(() => cb(...args));
    },
    argv: [],
    cwd: () => "/",
  };
}

export {};
