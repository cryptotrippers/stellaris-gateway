// Node module hooks for the unit-test runner (E11): component tests import
// modules that pull in images and stylesheets the way Vite does. Node can't
// load those, so each one resolves to a tiny module whose default export is
// the file's base name. Only used by `npm test`; never shipped.
const ASSET = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|woff2?|mp4|webm)(\?.*)?$/i;

// `import x from "./file?raw"` (Vite) resolves to the file's text.
const RAW = /\?raw$/;

export async function resolve(specifier, context, nextResolve) {
  if (RAW.test(specifier)) {
    const url = new URL(specifier.replace(RAW, ""), context.parentURL ?? "file:///").href;
    return { url: `${url}?raw-text`, shortCircuit: true };
  }
  if (ASSET.test(specifier)) {
    const url = new URL(specifier.replace(/\?.*$/, ""), context.parentURL ?? "file:///").href;
    return { url: `${url}?asset-stub`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith("?raw-text")) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(new URL(url.replace(/\?raw-text$/, "")), "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(text)};`,
      shortCircuit: true,
    };
  }
  if (url.endsWith("?asset-stub")) {
    const name = new URL(url).pathname.split("/").pop();
    return {
      format: "module",
      source: `export default ${JSON.stringify(name)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
