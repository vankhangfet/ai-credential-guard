import { loadRules, loadConfig } from "../engine/loader";
import { scanText } from "../engine/scanner";
import { appendAuditEvent } from "../audit/log";
import { hasValidBypass } from "../bypass/store";
import { findProjectRoot } from "../root";

export function extractPrompt(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      const p = [j?.prompt, j?.input, j?.message, j?.text].find((v) => typeof v === "string");
      return typeof p === "string" ? p : null;
    } catch { /* fallthrough */ }
  }
  return s; // raw text
}

export async function checkPrompt(argv: string[], input: string): Promise<number> {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 && argv[rootIdx + 1] !== undefined ? argv[rootIdx + 1] : process.cwd();
  const toolIdx = argv.indexOf("--tool");
  const tool = toolIdx >= 0 && argv[toolIdx + 1] !== undefined ? argv[toolIdx + 1] : "unknown";
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
    "ai-guard: ĐÃ CHẶN — phát hiện credential trong prompt (không gửi tới AI).",
    ...blocks.slice(0, 5).map((f) => `  • ${f.ruleId}: ${f.description} [preview: ${f.preview}]`),
  ];
  if (blocks.length > 5) lines.push(`  • ... và ${blocks.length - 5} findings khác`);
  lines.push("Nếu bạn CỐ Ý muốn gửi nội dung này, chạy lệnh sau rồi gửi lại prompt:");
  lines.push("  npx ai-guard allow prompt --5m");
  lines.push("(Lần gửi kế tiếp trong thời gian cho phép sẽ được ghi vào audit log.)");
  process.stderr.write(lines.join("\n") + "\n");
  return 2;
}
