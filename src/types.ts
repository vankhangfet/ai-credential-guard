export type Severity = "block" | "warn";

export interface Rule {
  id: string;
  severity: Severity;
  pattern: string;          // rỗng nếu builtin detector
  description: string;
  builtin?: "generic-secret" | "high-entropy";
}

export interface CompiledRule extends Rule {
  re?: RegExp;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  description: string;
  preview: string;          // masked
}

export interface ProjectRules {
  add?: Rule[];
  override?: Record<string, { severity?: Severity }>;
  remove?: string[];
}

export interface AiGuardConfig {
  sensitivePaths?: string[];
  genericSecret?: boolean;   // default true
  highEntropy?: boolean;     // default true
}

export type AuditAction = "blocked" | "warned" | "bypass_granted" | "allowed_after_confirm";

export interface AuditEvent {
  ts: string;
  tool: string;
  event: "prompt" | "file" | "bypass";
  action: AuditAction;
  rule?: string;
  preview?: string;
  path?: string;
  scope?: string;
  duration_min?: number;
  count?: number;
}
