// Prints top-level declarations of a TypeScript source file with every comment
// removed, so two versions of a module can be compared on what they DO and
// what they ACCEPT, not on their docs. Used by legacy-api.test.ts to prove the
// 0.2.0 OAuth surface is unchanged byte for byte (only JSDoc may differ).
import ts from "typescript";

/** The printed declaration of each requested top-level name ("" if absent). */
export function printDeclarations(source: string, names: readonly string[]): Record<string, string> {
  const sf = ts.createSourceFile("m.ts", source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const out: Record<string, string> = {};
  for (const name of names) out[name] = "";
  for (const st of sf.statements) {
    for (const name of declaredNames(st)) {
      if (!(name in out)) continue;
      // A private helper that moved to another module gains `export`; that is
      // not a change in what it does.
      out[name] = printer.printNode(ts.EmitHint.Unspecified, st, sf).replace(/^export /, "");
    }
  }
  return out;
}

function declaredNames(st: ts.Statement): string[] {
  if (
    ts.isFunctionDeclaration(st) ||
    ts.isInterfaceDeclaration(st) ||
    ts.isClassDeclaration(st) ||
    ts.isTypeAliasDeclaration(st)
  ) {
    return st.name ? [st.name.text] : [];
  }
  if (ts.isVariableStatement(st)) {
    return st.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  }
  return [];
}

/** Every `export [type] { … } from "…"` clause of an index module. */
export function exportClauses(indexSource: string): { typeOnly: boolean; names: string[]; module: string }[] {
  const out: { typeOnly: boolean; names: string[]; module: string }[] = [];
  const re = /export\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
  for (let m = re.exec(indexSource); m; m = re.exec(indexSource)) {
    const names = m[2]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim());
    out.push({ typeOnly: !!m[1], names, module: m[3]! });
  }
  return out;
}
