import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiGuardConfig, CompiledRule, JevConfig, ProjectRules, Rule, Severity } from "../types";
import { builtInRules, compileRules } from "./rules";
import { DEFAULT_SENSITIVE_PATHS } from "./paths";

function readJsonSafe(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf8");
    return JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  } catch {
    return null;
  }
}

export function loadRules(projectRoot: string): CompiledRule[] {
  const raw = readJsonSafe(join(projectRoot, ".ai-guard", "rules.json")) as ProjectRules | null;
  let rules: Rule[] = [...builtInRules];
  if (raw) {
    if (Array.isArray(raw.remove)) {
      const gone = new Set(raw.remove);
      rules = rules.filter((r) => !gone.has(r.id));
    }
    if (Array.isArray(raw.add)) {
      const adds = raw.add.filter((r) => r && typeof r.id === "string" && typeof r.pattern === "string" && (r.severity === "block" || r.severity === "warn") && typeof r.description === "string");
      for (const a of adds) rules = rules.some((r) => r.id === a.id) ? rules.map((r) => (r.id === a.id ? a : r)) : [...rules, a];
    }
    const ov = raw.override;
    if (ov) {
      rules = rules.map((r) => (ov[r.id]?.severity === "block" || ov[r.id]?.severity === "warn" ? { ...r, severity: ov[r.id].severity! } : r));
    }
  }
  return compileRules(rules).filter((r) => (r.pattern === "" ? true : !!r.re));
}

export function loadConfig(projectRoot: string): AiGuardConfig {
  const cfg = (readJsonSafe(join(projectRoot, ".ai-guard", "config.json")) ?? {}) as AiGuardConfig;
  return {
    sensitivePaths: Array.isArray(cfg.sensitivePaths) && cfg.sensitivePaths.length ? cfg.sensitivePaths : DEFAULT_SENSITIVE_PATHS,
    genericSecret: cfg.genericSecret ?? true,
    highEntropy: cfg.highEntropy ?? true,
    jev: normalizeJevConfig(cfg.jev),
  };
}

// JEV mặc định TẮT: chỉ coi là enabled khi enabled===true VÀ có endpoint hợp lệ. Giá trị out-of-range
// được kẹp về default an toàn. Không throw — config lỗi -> trả về disabled (fail-open).
function normalizeJevConfig(j: JevConfig | undefined): JevConfig {
  if (!j || typeof j !== "object") return { enabled: false };
  const endpoint = typeof j.endpoint === "string" ? j.endpoint.trim() : "";
  const enabled = j.enabled === true && endpoint.length > 0;
  const threshold = typeof j.threshold === "number" && j.threshold >= 0 && j.threshold <= 1 ? j.threshold : 0.8;
  const timeoutMs = typeof j.timeoutMs === "number" && j.timeoutMs > 0 ? Math.min(j.timeoutMs, 30000) : 5000;
  const mode: Severity = j.mode === "block" ? "block" : "warn";
  return {
    enabled,
    endpoint: endpoint || undefined,
    apiKeyEnv: typeof j.apiKeyEnv === "string" && j.apiKeyEnv.trim() ? j.apiKeyEnv.trim() : "JEV_API_KEY",
    model: typeof j.model === "string" && j.model.trim() ? j.model.trim() : undefined,
    mode,
    threshold,
    timeoutMs,
  };
}
