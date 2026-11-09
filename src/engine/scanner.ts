import type { AiGuardConfig, CompiledRule, Finding } from "../types";
import { isPlaceholder, maskSecret } from "./mask";
import { isHighEntropyToken } from "./entropy";

// (?<![a-z0-9]) replaces the leading \b: allows a "_" prefix in DB_PASSWORD/MY_API_KEY
// (\b does not match between "_" and a letter since both are word chars);
// ["']? after \b: supports the JSON form "password": "value" (quote comes before the colon)
const GENERIC_ASSIGN_RE =
  /(?<![a-z0-9])(passwo?rd|passwd|secret|secret[_-]?key|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|client[_-]?secret|admin[_-]?pass)\b["']?\s*[:=]\s*["']?([^\s"']{8,})["']?/gi;
const TOKEN_CANDIDATE_RE = /[A-Za-z0-9+/_$&!#%-]{20,}/g;
const MAX_FINDINGS = 20;

export function scanText(text: string, rules: CompiledRule[], cfg: AiGuardConfig): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (!rule.re) continue;
    rule.re.lastIndex = 0;
    const m = rule.re.exec(text);
    if (m && m[0]) {
      findings.push({ ruleId: rule.id, severity: rule.severity, description: rule.description, preview: maskSecret(m[0]) });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  if (cfg.genericSecret) {
    GENERIC_ASSIGN_RE.lastIndex = 0;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = GENERIC_ASSIGN_RE.exec(text)) !== null) {
      const value = m[2];
      if (seen.has(value)) continue;
      seen.add(value);
      // a key context (password=/api_key:) is already a strong signal — only filter placeholders;
      // do NOT add an entropy gate here (it would miss random lowercase secrets, Task 3 review)
      if (!isPlaceholder(value)) {
        findings.push({ ruleId: "generic-secret", severity: "warn", description: "Secret value assigned in text", preview: maskSecret(value) });
        if (findings.length >= MAX_FINDINGS) return findings;
      }
    }
  }
  if (cfg.highEntropy) {
    const seen = new Set<string>();
    for (const token of text.match(TOKEN_CANDIDATE_RE) ?? []) {
      if (seen.has(token)) continue;
      seen.add(token);
      if (isPlaceholder(token)) continue;
      if (isHighEntropyToken(token)) {
        findings.push({ ruleId: "high-entropy", severity: "warn", description: "High-entropy token", preview: maskSecret(token) });
        if (findings.length >= MAX_FINDINGS) return findings;
      }
    }
  }
  return findings;
}
