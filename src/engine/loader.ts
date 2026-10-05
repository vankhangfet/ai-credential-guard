import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiGuardConfig, CompiledRule, ProjectRules, Rule } from "../types";
import { builtInRules, compileRules } from "./rules";
import { DEFAULT_SENSITIVE_PATHS } from "./paths";

function readJsonSafe(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function loadRules(projectRoot: string): CompiledRule[] {
  const raw = readJsonSafe(join(projectRoot, ".ai-guard", "rules.json")) as ProjectRules | null;
  let rules: Rule[] = [...builtInRules];
  if (raw) {
    if (Array.isArray(raw.add)) rules = rules.concat(raw.add.filter((r) => r && r.id && r.pattern !== undefined));
    if (raw.override) {
      rules = rules.map((r) => (raw.override![r.id]?.severity ? { ...r, severity: raw.override![r.id].severity! } : r));
    }
    if (Array.isArray(raw.remove)) {
      const gone = new Set(raw.remove);
      rules = rules.filter((r) => !gone.has(r.id));
    }
  }
  return compileRules(rules).filter((r) => r.pattern === "" ? true : !!r.re);
}

export function loadConfig(projectRoot: string): AiGuardConfig {
  const cfg = (readJsonSafe(join(projectRoot, ".ai-guard", "config.json")) ?? {}) as AiGuardConfig;
  return {
    sensitivePaths: Array.isArray(cfg.sensitivePaths) && cfg.sensitivePaths.length ? cfg.sensitivePaths : DEFAULT_SENSITIVE_PATHS,
    genericSecret: cfg.genericSecret ?? true,
    highEntropy: cfg.highEntropy ?? true,
  };
}
