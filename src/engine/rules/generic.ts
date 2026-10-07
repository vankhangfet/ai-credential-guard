import type { Rule } from "../../types";

export const genericRules: Rule[] = [
  { id: "generic-secret", severity: "warn", description: "Secret value assigned to password/secret/api_key", pattern: "", builtin: "generic-secret" },
  { id: "high-entropy", severity: "warn", description: "High-entropy token likely a secret", pattern: "", builtin: "high-entropy" },
];
