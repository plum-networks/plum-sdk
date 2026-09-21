// @plumbox/manifest — the manifest.json JSON Schema as data.
//
// `manifest.schema.json` is the single source of truth for what a Plum Box app
// manifest may contain: plum-box-core's installer (internal/apps/manifest.go)
// enforces it, @plumbox/dev mirrors it in TypeScript (a test keeps the two in
// step) and the Plum Store validates uploads against this very file. Consumers
// that speak JSON Schema should validate against the schema rather than
// re-implement the rules.
//
//   import { manifestSchema } from '@plumbox/manifest';
//   const validate = new Ajv({ strict: false }).compile(manifestSchema);
//
// Tools that need the file on disk (ajv-cli, a Python validator, a linter)
// should use `manifestSchemaPath`, which is a real path inside the package.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** The parsed JSON Schema (draft-07). */
export const manifestSchema = require('./manifest.schema.json');

/** Absolute path of manifest.schema.json inside the installed package. */
export const manifestSchemaPath = fileURLToPath(new URL('./manifest.schema.json', import.meta.url));

/** The schema's `$id`, which is also the URL it is published at. */
export const SCHEMA_ID = manifestSchema.$id;

export default manifestSchema;
