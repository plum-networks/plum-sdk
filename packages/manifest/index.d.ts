/** A JSON Schema document (draft-07). Kept loose on purpose: validators take it as data. */
export type JSONSchema = Record<string, unknown>;

/** The parsed manifest.json JSON Schema (draft-07). */
export declare const manifestSchema: JSONSchema;

/** Absolute path of manifest.schema.json inside the installed package. */
export declare const manifestSchemaPath: string;

/** The schema's `$id`, which is also the URL it is published at. */
export declare const SCHEMA_ID: string;

export default manifestSchema;
