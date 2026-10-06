import { isAbsolute, join, relative } from "node:path";
import { findProjectRoot } from "../root";
import { loadConfig } from "../engine/loader";
import { isSensitivePath, normalizePath } from "../engine/paths";
import { appendAuditEvent } from "../audit/log";
import { hasValidBypass } from "../bypass/store";
import { flagValue } from "../util/argv";

// apply_patch (Codex): path nằm trong patch text — "*** Update File: <path>" ở header mỗi hunk.
const PATCH_FILE_RE = /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/g;

// Thu thập path candidates theo thứ tự ưu tiên:
// 1) argv positional (cuối cùng, như cũ) — CHỈ dùng nó nếu có (giữ semantics cũ).
// 2) stdin JSON: direct field đầu tiên (file_path|notebook_path|path|j.path) — explicit path wins, KHÔNG scan patch.
// 3) nếu không có path tường minh nào: MỌI patch header trong tool_input.input|command|patch
//    (caller chặn candidate sensitive ĐẦU TIÊN — .env ở đâu trong patch cũng bị bắt).
function extractPathCandidates(argv: string[], input: string): string[] {
  // heuristic: loại giá trị của flag ra khỏi positional — các flag tương lai PHẢI nhận giá trị (dạng --flag value), flag boolean sẽ cần cập nhật đây
  const flagVals = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flagVals.add(argv[i + 1]);
  }
  const positional = argv.filter((a) => !a.startsWith("--") && !flagVals.has(a));
  if (positional.length) return [positional[positional.length - 1]];
  const s = input.trim();
  if (!s.startsWith("{")) return [];
  try {
    const j = JSON.parse(s);
    // v1: tool_input.path là thư mục (Grep/Glob base) chỉ chặn nếu chính tên thư mục match pattern; không liệt kê file con
    const ti = j?.tool_input ?? {};
    const p = [ti.file_path, ti.notebook_path, ti.path, j?.path].find((v) => typeof v === "string");
    if (typeof p === "string") return [p];
    // không có path tường minh — thu thập TẤT CẢ patch header (first-sensitive-wins ở caller)
    const out: string[] = [];
    for (const key of ["input", "command", "patch"]) {
      const v = ti[key] ?? j?.[key];
      if (typeof v === "string") {
        let m: RegExpExecArray | null;
        PATCH_FILE_RE.lastIndex = 0;
        while ((m = PATCH_FILE_RE.exec(v)) !== null) {
          const t = m[1].trim();
          if (t) out.push(t);
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function checkFile(argv: string[], input: string): Promise<number> {
  const rootArg = flagValue(argv, "--root");
  const root = rootArg !== undefined ? rootArg : process.cwd();
  const tool = flagValue(argv, "--tool") ?? "unknown";
  const projectRoot = findProjectRoot(root);
  if (!projectRoot) return 0;
  const candidates = extractPathCandidates(argv, input);
  if (candidates.length === 0) return 0;
  const cfg = loadConfig(projectRoot);
  for (const raw of candidates) {
    const abs = isAbsolute(raw) ? raw : join(projectRoot, raw);
    const rel = normalizePath(relative(projectRoot, abs) || raw);
    if (!isSensitivePath(rel, cfg.sensitivePaths ?? [])) continue;
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
  return 0;
}
