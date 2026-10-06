import { compileRules, builtInRules } from "../engine/rules";
import { scanText } from "../engine/scanner";
import { DEFAULT_SENSITIVE_PATHS } from "../engine/paths";
import { FIXTURES } from "../selftest-fixtures";
import type { AiGuardConfig } from "../types";

// Tự kiểm tra engine với bộ fixture built-in (KHÔNG load project rules) —
// dùng cho CI / verify sau khi cài: nếu fail thì engine hoặc rule bị hỏng.
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

// In kết quả self-test: từng failure (thụt lề nếu có) + dòng tổng kết "X/Y pass".
// Dùng chung cho cli `self-test` (label mặc định) và doctor (label "Engine self-test", indent).
export function printSelfTest(r: { total: number; failures: string[] }, label = "self-test", indent = ""): void {
  r.failures.forEach((f) => console.log(indent + "✗ " + f));
  console.log(`${label}: ${r.total - r.failures.length}/${r.total} pass`);
}
