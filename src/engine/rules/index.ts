import type { CompiledRule, Rule } from "../../types";
import { cloudRules } from "./cloud";
import { aiRules } from "./ai";
import { vcsRules } from "./vcs";
import { saasRules } from "./saas";
import { dbRules } from "./db";
import { keyRules } from "./keys";
import { jwtRules } from "./jwt";
import { genericRules } from "./generic";

export const builtInRules: Rule[] = [
  ...cloudRules, ...aiRules, ...vcsRules, ...saasRules, ...dbRules, ...keyRules, ...jwtRules, ...genericRules,
];

export function compileRules(rules: Rule[]): CompiledRule[] {
  return rules.map((r) => {
    if (!r.pattern) return { ...r };
    try { return { ...r, re: new RegExp(r.pattern) }; }
    catch { return { ...r }; }
  });
}
