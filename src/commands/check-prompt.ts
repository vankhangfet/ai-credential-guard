import { loadRules, loadConfig } from "../engine/loader";
import { scanText } from "../engine/scanner";
import { appendAuditEvent } from "../audit/log";
import { hasValidBypass } from "../bypass/store";
import { findProjectRoot } from "../root";
import { flagValue } from "../util/argv";

export function extractPrompt(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      const p = [j?.prompt, j?.input, j?.message, j?.text].find((v) => typeof v === "string");
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
  const prompt = extractPrompt(input);
  if (!prompt) return 0;
  const projectRoot = findProjectRoot(root);
  if (!projectRoot) return 0; // chưa init -> fail-open
  const cfg = loadConfig(projectRoot);
  const rules = loadRules(projectRoot);
  const findings = scanText(prompt, rules, cfg);
  if (!findings.length) return 0;
  const blocks = findings.filter((f) => f.severity === "block");
  const warns = findings.filter((f) => f.severity === "warn");
  const nowISO = new Date().toISOString();
  if (warns.length) {
    appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "prompt", action: "warned", rule: warns[0].ruleId, preview: warns[0].preview, count: warns.length });
  }
  if (!blocks.length) return 0;
  if (hasValidBypass(projectRoot, "prompt")) {
    appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "prompt", action: "allowed_after_confirm", rule: blocks[0].ruleId, preview: blocks[0].preview, count: blocks.length });
    return 0;
  }
  appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "prompt", action: "blocked", rule: blocks[0].ruleId, preview: blocks[0].preview, count: blocks.length });
  const lines = [
    "ai-guard: BLOCKED — credential detected in prompt (not sent to AI).",
    ...blocks.slice(0, 5).map((f) => `  • ${f.ruleId}: ${f.description} [preview: ${f.preview}]`),
  ];
  if (blocks.length > 5) lines.push(`  • ... and ${blocks.length - 5} more findings`);
  lines.push("If you INTENTIONALLY want to send this, run the following then resubmit:");
  lines.push("  npx ai-guard allow prompt --5m");
  lines.push("(The next submission within the window will be recorded in the audit log.)");
  process.stderr.write(lines.join("\n") + "\n");
  return 2;
}
