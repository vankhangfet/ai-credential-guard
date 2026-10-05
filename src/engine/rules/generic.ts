import type { Rule } from "../../types";

export const genericRules: Rule[] = [
  { id: "generic-secret", severity: "warn", description: "Gán giá trị cho password/secret/api_key", pattern: "", builtin: "generic-secret" },
  { id: "high-entropy", severity: "warn", description: "Token entropy cao khả năng là secret", pattern: "", builtin: "high-entropy" },
];
