import { isAbsolute, join, relative } from "node:path";
import { findProjectRoot } from "../root";
import { loadConfig } from "../engine/loader";
import { isSensitivePath, normalizePath } from "../engine/paths";
import { appendAuditEvent } from "../audit/log";
import { hasValidBypass } from "../bypass/store";
import { flagValue } from "../util/argv";

function extractPath(argv: string[], input: string): string | null {
  // heuristic: loại giá trị của flag ra khỏi positional — các flag tương lai PHẢI nhận giá trị (dạng --flag value), flag boolean sẽ cần cập nhật đây
  const flagVals = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flagVals.add(argv[i + 1]);
  }
  const positional = argv.filter((a) => !a.startsWith("--") && !flagVals.has(a));
  if (positional.length) return positional[positional.length - 1];
  const s = input.trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      // v1: tool_input.path là thư mục (Grep/Glob base) chỉ chặn nếu chính tên thư mục match pattern; không liệt kê file con
      const ti = j?.tool_input ?? {};
      const p = [ti.file_path, ti.notebook_path, ti.path, j?.path].find((v) => typeof v === "string");
      return typeof p === "string" ? p : null;
    } catch { return null; }
  }
  return null;
}

export async function checkFile(argv: string[], input: string): Promise<number> {
  const rootArg = flagValue(argv, "--root");
  const root = rootArg !== undefined ? rootArg : process.cwd();
  const tool = flagValue(argv, "--tool") ?? "unknown";
  const projectRoot = findProjectRoot(root);
  if (!projectRoot) return 0;
  const raw = extractPath(argv, input);
  if (!raw) return 0;
  const abs = isAbsolute(raw) ? raw : join(projectRoot, raw);
  const rel = normalizePath(relative(projectRoot, abs) || raw);
  const cfg = loadConfig(projectRoot);
  if (!isSensitivePath(rel, cfg.sensitivePaths ?? [])) return 0;
  if (hasValidBypass(projectRoot, "file", rel)) {
    appendAuditEvent(projectRoot, { ts: new Date().toISOString(), tool, event: "file", action: "allowed_after_confirm", path: rel });
    return 0;
  }
  appendAuditEvent(projectRoot, { ts: new Date().toISOString(), tool, event: "file", action: "blocked", path: rel });
  process.stderr.write(
    [
      "ai-guard: ĐÃ CHẶN — file nhạy cảm (chưa cho AI đọc/ghi).",
      `  • Path: ${rel}`,
      "Nếu bạn CỐ Ý muốn cho phép file này, chạy:",
      `  npx ai-guard allow file ${rel} --10m`,
    ].join("\n") + "\n"
  );
  return 2;
}
