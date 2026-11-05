import { loadRules, loadConfig } from "../engine/loader";
import { scanText } from "../engine/scanner";
import { scanWithJev } from "../engine/jev";
import { appendAuditEvent } from "../audit/log";
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
      // Alias keys mở rộng cho Kiro UserPromptSubmit (user-verified: prompt text findable
      // dưới prompt|userPrompt|message|text|input|content, và lồng data.prompt|triggerData.prompt
      // cho shape kiro #10346) — SUPERSET của fallback/engine.py: nested shape của Kiro chỉ có
      // ở TS vì fallback chỉ phục vụ Claude Code/Codex.
      const p = [j?.prompt, j?.input, j?.message, j?.text, j?.userPrompt, j?.content, j?.data?.prompt, j?.triggerData?.prompt].find((v) => typeof v === "string");
      // JSON hợp lệ nhưng KHÔNG alias field nào là string (hook payload dùng field name lạ) ->
      // fall-through quét RAW: prompt/secret vẫn nằm nguyên văn trong JSON text (fallback
      // alias-miss của cline UserPromptSubmit shim truyền nguyên raw stdin).
      if (typeof p === "string") return p;
    } catch { /* fallthrough */ }
  }
  return s; // raw text (hoặc raw JSON không có alias field nào)
}

export async function checkPrompt(argv: string[], input: string): Promise<number> {
  const rootArg = flagValue(argv, "--root");
  const root = rootArg !== undefined ? rootArg : process.cwd();
  const tool = flagValue(argv, "--tool") ?? "unknown";
  const warnOnly = argv.includes("--warn-only"); // boolean flag — dùng includes, KHÔNG flagValue (flagValue lấy value của flag kế tiếp)
  const prompt = extractPrompt(input);
  if (!prompt) return 0;
  const projectRoot = findProjectRoot(root);
  if (!projectRoot) return 0; // chưa init -> fail-open
  const cfg = loadConfig(projectRoot);
  const rules = loadRules(projectRoot);
  const findings = scanText(prompt, rules, cfg);
  // JEV / OpenJEV (optional, mặc định tắt): second opinion từ decision API. Fail-open hoàn toàn —
  // lỗi/timeout -> [] -> không đổi hành vi. Findings JEV gộp vào pipeline block/warn/bypass như regex.
  const jevScores = new Map<string, number>();
  const jevFindings = await scanWithJev(prompt, cfg.jev);
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
  const lines = [
    warnOnly
      ? "ai-guard: WARNING — credential detected in prompt. This tool cannot block prompts (platform limit): the text may still be sent to the model."
      : "ai-guard: BLOCKED — credential detected in prompt (not sent to AI).",
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

// Trích % confidence mà jev.ts đã nhúng vào description ("… (NN% confidence)") -> số 0..1 cho audit.
function parseJevScore(description: string): number | null {
  const m = description.match(/\((\d{1,3})% confidence\)/);
  if (!m) return null;
  return Math.max(0, Math.min(1, Number(m[1]) / 100));
}
