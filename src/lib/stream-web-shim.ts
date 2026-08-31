/**
 * Browser stand-in for `node:stream/web`.
 *
 * The node polyfill plugin maps `node:stream/web` onto a file that does not
 * exist in `stream-browserify`, which breaks dependency optimisation in dev.
 * Browsers ship the WHATWG streams natively, so re-export those instead.
 */
const g = globalThis as unknown as Record<string, unknown>;

export const ReadableStream = g["ReadableStream"];
export const WritableStream = g["WritableStream"];
export const TransformStream = g["TransformStream"];
export const ByteLengthQueuingStrategy = g["ByteLengthQueuingStrategy"];
export const CountQueuingStrategy = g["CountQueuingStrategy"];

export default {
  ReadableStream,
  WritableStream,
  TransformStream,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
};
