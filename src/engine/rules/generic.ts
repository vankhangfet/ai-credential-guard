import type { Rule } from "../../types";

export const genericRules: Rule[] = [
  { id: "generic-secret", severity: "warn", description: "Secret value assigned to password/secret/api_key", pattern: "", builtin: "generic-secret" },
  { id: "high-entropy", severity: "warn", description: "High-entropy token likely a secret", pattern: "", builtin: "high-entropy" },
  {
    id: "login-credential-pair",
    severity: "block",
    description: "Username + password credential pair (login context)",
    pattern: "(?<![a-z0-9])(?:[Uu]ser(?:[ _-]?[Nn]ame)?|[Ll]ogin)\\s*[:=@]\\s*[^\\s,;'\"&]{1,64}[^.]{0,120}?(?<![a-z0-9])(?:[Pp]asswo?rd|[Pp]asswd)\\s*[:=@]\\s*[^\\s,;'\"&]{1,64}|(?<![a-z0-9])(?:[Pp]asswo?rd|[Pp]asswd)\\s*[:=@]\\s*[^\\s,;'\"&]{1,64}[^.]{0,120}?(?<![a-z0-9])(?:[Uu]ser(?:[ _-]?[Nn]ame)?|[Ll]ogin)\\s*[:=@]\\s*[^\\s,;'\"&]{1,64}",
  },
];
