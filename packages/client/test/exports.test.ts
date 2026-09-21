// The package's public surface, checked two ways.
//
// A class listed in `export type { … }` is erased at build time: the .d.ts
// still advertises it as a value, so `import { AuthApi } from "@plumbox/client"`
// type-checks and then throws at runtime. That shipped once (AuthApi, fixed
// here); these tests make the whole class of mistake fail in CI instead.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.js";

const SRC = join(__dirname, "..", "src");
const indexTs = readFileSync(join(SRC, "index.ts"), "utf8");

/** Every `export [type] { … } from "./mod.js"` clause in src/index.ts. */
function clauses(): { typeOnly: boolean; names: string[]; module: string }[] {
  const out: { typeOnly: boolean; names: string[]; module: string }[] = [];
  const re = /export\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
  for (let m = re.exec(indexTs); m; m = re.exec(indexTs)) {
    const names = m[2]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim());
    out.push({ typeOnly: !!m[1], names, module: m[3]! });
  }
  return out;
}

/** How `name` is declared in the module it comes from. */
function declarationKind(moduleSpec: string, name: string): "value" | "type" | "unknown" {
  const file = join(SRC, moduleSpec.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
  if (!existsSync(file)) return "unknown";
  const src = readFileSync(file, "utf8");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^export\\s+(abstract\\s+)?class\\s+${esc}\\b`, "m").test(src)) return "value";
  if (new RegExp(`^export\\s+(async\\s+)?function\\s+${esc}\\b`, "m").test(src)) return "value";
  if (new RegExp(`^export\\s+(const|let|var)\\s+${esc}\\b`, "m").test(src)) return "value";
  if (new RegExp(`^export\\s+(interface|type)\\s+${esc}\\b`, "m").test(src)) return "type";
  return "unknown";
}

describe("public exports", () => {
  it("never puts a runtime value in an `export type` list", () => {
    const wrong: string[] = [];
    for (const c of clauses()) {
      if (!c.typeOnly) continue;
      for (const n of c.names) {
        if (declarationKind(c.module, n) === "value") wrong.push(`${n} (${c.module})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("never puts a pure type in a value `export` list", () => {
    const wrong: string[] = [];
    for (const c of clauses()) {
      if (c.typeOnly) continue;
      for (const n of c.names) {
        if (declarationKind(c.module, n) === "type") wrong.push(`${n} (${c.module})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("resolves every re-exported name to a declaration we understand", () => {
    const unknown: string[] = [];
    for (const c of clauses()) {
      for (const n of c.names) if (declarationKind(c.module, n) === "unknown") unknown.push(`${n} (${c.module})`);
    }
    expect(unknown).toEqual([]);
  });

  it("exports the classes and functions consumers construct or call", () => {
    for (const name of [
      "PlumClient",
      "AuthApi",
      "DriveApi",
      "AppsApi",
      "PlumApiError",
      "PlumAuthError",
      "discover",
      "beginAuthorization",
      "exchangeCode",
      "parseCallback",
      "injectedAdapter",
    ]) {
      expect(typeof (entry as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(typeof entry.fetchAdapter.request).toBe("function");
    expect(entry.DEFAULT_RELAY_URL).toMatch(/^https:\/\//);
    expect(entry.DEFAULT_PORTAL_URL).toMatch(/^https:\/\//);
  });

  it("the built bundle exports the same values as the source entry", async () => {
    const dist = join(__dirname, "..", "dist", "index.js");
    if (!existsSync(dist)) return; // `npm run build` has not run in this tree
    const built = (await import(dist)) as Record<string, unknown>;
    const missing = Object.keys(entry)
      .filter((k) => typeof (entry as Record<string, unknown>)[k] !== "undefined")
      .filter((k) => typeof built[k] === "undefined");
    expect(missing).toEqual([]);
  });
});
