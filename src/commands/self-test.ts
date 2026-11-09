import { compileRules, builtInRules } from "../engine/rules";
import { scanText } from "../engine/scanner";
import { DEFAULT_SENSITIVE_PATHS } from "../engine/paths";
import { FIXTURES } from "../selftest-fixtures";
import type { AiGuardConfig } from "../types";

// Self-check the engine against the built-in fixtures (does NOT load project rules) —
// for CI / post-install verification: a failure means the engine or a rule is broken.
export function selfTest(): { total: number; failures: string[] } {
  const rules = compileRules(builtInRules);
  const cfg: AiGuardConfig = { genericSecret: true, highEntropy: true, sensitivePaths: DEFAULT_SENSITIVE_PATHS };
  const failures: string[] = [];
  for (const f of FIXTURES) {
    const findings = scanText(f.input, rules, cfg);
    const blocked = findings.some((x) => x.severity === "block");
    const ruleOk = f.expectRule ? findings.some((x) => x.ruleId === f.expectRule) : true;
    if (blocked !== f.expectBlocked || !ruleOk) {
      failures.push(
        `${f.name}: expected rule=${f.expectRule ?? "-"} blocked=${f.expectBlocked}, got [${findings.map((x) => x.ruleId).join(",")}]`,
      );
    }
  }
  return { total: FIXTURES.length, failures };
}

// Print self-test results: each failure (indented if requested) + a "X/Y pass" summary line.
// Shared by the `self-test` cli (default label) and doctor (label "Engine self-test", indent).
export function printSelfTest(r: { total: number; failures: string[] }, label = "self-test", indent = ""): void {
  r.failures.forEach((f) => console.log(indent + "✗ " + f));
  console.log(`${label}: ${r.total - r.failures.length}/${r.total} pass`);
}
