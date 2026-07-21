import { createRequire } from "node:module";
import { defineConfig } from "tsup";

// Inline libsodium (from its working CJS build) so consumers — notably
// Obsidian's esbuild bundler — get a self-contained artifact and never hit the
// package's broken ESM `import` condition (its .mjs references a core module
// that isn't co-located). The alias forces esbuild to the CJS entry.
const require = createRequire(import.meta.url);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  noExternal: ["libsodium-wrappers-sumo"],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      "libsodium-wrappers-sumo": require.resolve("libsodium-wrappers-sumo"),
    };
  },
});
