// The package's one job: hand the schema to a validator, as data or as a path.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import manifestSchemaDefault, { SCHEMA_ID, manifestSchema, manifestSchemaPath } from '../index.js';

test('exports the parsed schema', () => {
  assert.equal(manifestSchema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(manifestSchema.type, 'object');
  assert.deepEqual(manifestSchema.required, ['id', 'name', 'version']);
  assert.equal(manifestSchemaDefault, manifestSchema);
  assert.equal(SCHEMA_ID, manifestSchema.$id);
});

test('manifestSchemaPath points at the same document on disk', () => {
  assert.deepEqual(JSON.parse(readFileSync(manifestSchemaPath, 'utf8')), manifestSchema);
});

test('describes the fields the box enforces', () => {
  for (const key of ['id', 'name', 'version', 'entry', 'icon', 'permissions', 'server']) {
    assert.ok(manifestSchema.properties[key], `schema is missing "${key}"`);
  }
});
