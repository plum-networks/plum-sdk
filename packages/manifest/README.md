# @plumbox/manifest

The JSON Schema for a Plum Box app manifest (`manifest.json`), packaged so every
tool can validate against the same document instead of re-deriving the rules.

Three implementations already read it:

| Where | How |
|---|---|
| `plum-box-core` (`internal/apps/manifest.go`) | enforces the same rules at install time — the schema is the written form of them |
| `@plumbox/dev` (`plum-dev validate`) | mirrors it in TypeScript; a test in this repo fails if the two drift |
| Plum Store upload checks (`app/manifest.py`) | validates the uploaded bundle against this file with `jsonschema` |

## Install

```bash
npm i @plumbox/manifest
```

## Use

```js
import Ajv from 'ajv';
import { manifestSchema } from '@plumbox/manifest';

const validate = new Ajv({ strict: false }).compile(manifestSchema);
if (!validate(JSON.parse(manifestJson))) console.error(validate.errors);
```

Tools that want the file itself — `ajv-cli`, a Python validator, an editor's
`json.schemas` setting — can use the path:

```js
import { manifestSchemaPath } from '@plumbox/manifest';   // …/node_modules/@plumbox/manifest/manifest.schema.json
```

```jsonc
// .vscode/settings.json
{ "json.schemas": [{ "fileMatch": ["manifest.json"], "url": "https://developer.plum.im/schemas/manifest-v1.json" }] }
```

## What it covers

`id`, `name`, `version` (required), `entry`, `icon`, `description`,
`mimeTypes`, `mobile`, `permissions` (the four the box grants),
`server` (`bin`, `args`, `healthPath`, `limits.memory|cpu|pids`) and
`clients[]` (companion-app OAuth clients: `client_id`, `display_name`,
`platform`, `redirect_uris`, `scopes_allowed`).

The schema is deliberately `additionalProperties: true`: a manifest written for
a newer box still validates on an older one, and the box ignores what it does
not know. What the schema cannot check — the entry file actually being in the
bundle, the server binary being an arm64 ELF, the zip caps — is checked by
`plum-dev validate` and again by the box.

## License

MIT
