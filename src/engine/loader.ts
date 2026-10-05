import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiGuardConfig, CompiledRule, ProjectRules, Rule } from "../types";
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
  };
}
