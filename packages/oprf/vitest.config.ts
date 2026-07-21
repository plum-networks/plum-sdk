import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// libsodium-wrappers-sumo's ESM build (`module`/`exports.import`) has a broken
// relative import to its core wasm module; the CJS build is fine. Resolve the
// concrete CJS file and alias to that absolute path so Node's ESM loader (and
// the package `exports` map, which only exposes ".") don't get in the way. The
// shipped bundle handles this via tsup, which follows `exports.require` (CJS)
// and inlines libsodium.
const require = createRequire(import.meta.url);
const sodiumCjs = require.resolve("libsodium-wrappers-sumo");

export default defineConfig({
  resolve: {
    alias: {
      "libsodium-wrappers-sumo": sodiumCjs,
    },
  },
});
