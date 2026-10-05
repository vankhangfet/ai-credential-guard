import type { Rule } from "../../types";

export const jwtRules: Rule[] = [
  { id: "jwt", severity: "warn", description: "JWT token", pattern: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{5,}\\b" },
];
