import { loadRules, loadConfig } from "../engine/loader";
import { scanText } from "../engine/scanner";
import { scanWithJev, jevCacheFile } from "../engine/jev";
import { appendAuditEvent, logJevCall } from "../audit/log";
import { hasValidBypass } from "../bypass/store";
import { findProjectRoot } from "../root";
import { flagValue } from "../util/argv";
import type { Finding } from "../types";

export function extractPrompt(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      // Extended alias keys for Kiro UserPromptSubmit (user-verified: prompt text findable
      // under prompt|userPrompt|message|text|input|content, and nested data.prompt|triggerData.prompt
      // for kiro shape #10346) — SUPERSET of fallback/engine.py: Kiro's nested shape exists
      // only in TS because the fallback only serves Claude Code/Codex.
      const p = [j?.prompt, j?.input, j?.message, j?.text, j?.userPrompt, j?.content, j?.data?.prompt, j?.triggerData?.prompt].find((v) => typeof v === "string");
      // Valid JSON but NO alias field is a string (hook payload uses unusual field names) ->
      // fall through and scan RAW: the prompt/secret still appears verbatim in the JSON text (fallback
      // for alias-miss; the cline UserPromptSubmit shim passes raw stdin through unchanged).
      if (typeof p === "string") return p;
    } catch { /* fallthrough */ }
  }
  return s; // raw text (or raw JSON with no alias field)
}

export async function checkPrompt(argv: string[], input: string): Promise<number> {
  const rootArg = flagValue(argv, "--root");
  const root = rootArg !== undefined ? rootArg : process.cwd();
  const tool = flagValue(argv, "--tool") ?? "unknown";
  const warnOnly = argv.includes("--warn-only"); // boolean flag — use includes, NOT flagValue (flagValue takes the value of the next flag)
  const prompt = extractPrompt(input);
  if (!prompt) return 0;
  const projectRoot = findProjectRoot(root);
  if (!projectRoot) return 0; // not initialized -> fail-open
  const cfg = loadConfig(projectRoot);
  const rules = loadRules(projectRoot);
  const findings = scanText(prompt, rules, cfg);
  // JEV / OpenJEV (optional, off by default): second opinion from the decision API. Fully fail-open —
  // error/timeout -> [] -> no behavior change. JEV findings merge into the block/warn/bypass pipeline like regex ones.
  const jevScores = new Map<string, number>();
  const jevFindings = findings.some((f) => f.severity === "block")
    ? []
    : await scanWithJev(prompt, cfg.jev, undefined, (info) => logJevCall(projectRoot, tool, "prompt", cfg.jev, info), { cacheFile: jevCacheFile(projectRoot) });
  for (const f of jevFindings) {
    const score = parseJevScore(f.description);
    if (score !== null) jevScores.set(f.ruleId, score);
  }
  const allFindings: Finding[] = [...findings, ...jevFindings];
  if (!allFindings.length) return 0;
  const blocks = allFindings.filter((f) => f.severity === "block");
  const warns = allFindings.filter((f) => f.severity === "warn");
  const nowISO = new Date().toISOString();
  if (warns.length) {
    const w = warns[0];
    appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "prompt", action: "warned", rule: w.ruleId, preview: w.preview, count: warns.length, source: jevScores.has(w.ruleId) ? "jev" : "engine", score: jevScores.get(w.ruleId) });
  }
  if (!blocks.length) return 0;
  if (hasValidBypass(projectRoot, "prompt")) {
    const b = blocks[0];
    appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "prompt", action: "allowed_after_confirm", rule: b.ruleId, preview: b.preview, count: blocks.length, source: jevScores.has(b.ruleId) ? "jev" : "engine", score: jevScores.get(b.ruleId) });
    return 0;
  }
  const b0 = blocks[0];
  appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "prompt", action: warnOnly ? "warned" : "blocked", rule: b0.ruleId, preview: b0.preview, count: blocks.length, source: jevScores.has(b0.ruleId) ? "jev" : "engine", score: jevScores.get(b0.ruleId) });
  // headline depends on WHAT was found: JEV's unauthorized-access question flags intent (injection /
  // exfiltration), not a credential — saying "credential detected" there would mislead the user
  const what = blocks.every((f) => f.ruleId === "jev-unauthorized-access")
    ? "prompt-injection / exfiltration attempt detected"
    : "credential detected";
  const lines = [
    warnOnly
      ? `ai-guard: WARNING — ${what} in prompt. This tool cannot block prompts (platform limit): the text may still be sent to the model.`
      : `ai-guard: BLOCKED — ${what} in prompt (not sent to AI).`,
    ...blocks.slice(0, 5).map((f) => `  • ${f.ruleId}: ${f.description} [preview: ${f.preview}]`),
  ];
  if (blocks.length > 5) lines.push(`  • ... and ${blocks.length - 5} more findings`);
  lines.push(
    warnOnly
      ? "To silence this warning for intentional sends, run the following then resubmit:"
      : "If you INTENTIONALLY want to send this, run the following then resubmit:",
    "  npx ai-guard allow prompt --5m",
    "(The next submission within the window will be recorded in the audit log.)",
  );
  process.stderr.write(lines.join("\n") + "\n");
  return 2;
}

// Extract the % confidence that jev.ts embedded in the description ("… (NN% confidence)") -> number 0..1 for audit.
function parseJevScore(description: string): number | null {
  const m = description.match(/\((\d{1,3})% confidence\)/);
  if (!m) return null;
  return Math.max(0, Math.min(1, Number(m[1]) / 100));
}
