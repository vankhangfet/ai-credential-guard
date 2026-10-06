import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtInRules } from "../engine/rules";
import type { Rule } from "../types";

export function buildRulesArtifact(): Rule[] {
  // mirror contract: exactly these 5 fields — update engine.py loader if changed
  return builtInRules.map(({ id, severity, pattern, description, builtin }) =>
    builtin ? { id, severity, pattern, description, builtin } : { id, severity, pattern, description });
}

if (require.main === module) {
  const outDir = join(__dirname, ".."); // dist/
  const outFile = join(outDir, "rules.json");
  writeFileSync(outFile, JSON.stringify(buildRulesArtifact(), null, 2) + "\n");
  console.log("wrote " + outFile);
}
