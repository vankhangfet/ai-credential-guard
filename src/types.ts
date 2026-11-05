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

// Cấu hình cho JEV / OpenJEV (hoặc bất kỳ server tương thích openjev-server): một decision API
// nhận text + câu hỏi, trả xác suất calibrated per-question. TẤT CẢ optional, mặc định TẮT ->
// không bật nếu user không cấu hình (giữ nguyên hành vi fail-open, offline, không network).
// API key KHÔNG lưu trong config (file này không gitignore mặc định, và cả mục đích của tool là
// giữ secret ra khỏi file) — key đọc từ biến môi trường (apiKeyEnv, mặc định JEV_API_KEY).
export interface JevConfig {
  enabled?: boolean;         // default false — phải bật tường minh
  endpoint?: string;         // URL decision API, vd http://localhost:8000/v1/decide
  apiKeyEnv?: string;        // tên biến môi trường chứa API key (default "JEV_API_KEY")
  model?: string;            // optional — chọn model trên openjev-server (vd "openjev")
  mode?: Severity;           // severity cho finding JEV (default "warn" — không chặn cứng theo mặc định)
  threshold?: number;        // ngưỡng xác suất 0..1 để coi là phát hiện (default 0.8)
  timeoutMs?: number;        // timeout request (default 1500) — fail-open khi quá hạn
}

export interface AiGuardConfig {
  sensitivePaths?: string[];
  genericSecret?: boolean;   // default true
  highEntropy?: boolean;     // default true
  jev?: JevConfig;           // optional external decision API (default disabled)
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
  source?: "engine" | "jev"; // finding đến từ regex engine hay từ decision API JEV
  score?: number;            // xác suất calibrated 0..1 do JEV trả (chỉ khi source="jev")
}
