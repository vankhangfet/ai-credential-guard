import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER, readJson, writeJson } from "../util/json-config";

interface HookEntry { matcher?: string; hooks?: Array<{ type: string; command: string }> }
interface CodexHooks { description?: string; hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

const CMD_PROMPT = "npx --no-install ai-guard check-prompt --tool codex";
const CMD_FILE = "npx --no-install ai-guard check-file --tool codex";

// Codex tool names (docs chính thức): file edits qua `apply_patch` (matcher nhận alias Edit|Write),
// MCP tools theo tên đầy đủ `mcp__filesystem__read_file`... — không có tool "read|grep|glob" lowercase.
const FILE_MATCHER = "Edit|Write|apply_patch|mcp__.*";

const INSTRUCTION = [
  "<!-- ai-guard:start -->",
  "## Bảo mật credential (ai-guard)",
  "",
  "- KHÔNG yêu cầu hoặc đọc credential thật (`.env`, `*.pem`, `id_rsa`, `credentials*`). Dùng `.env.example` hoặc giá trị giả (dummy) khi cần minh hoạ.",
  "- KHÔNG lặp lại secret mà user đã dán vào prompt — cảnh báo user xoá và xoay khoá (rotate) ngay.",
  "",
  "<!-- ai-guard:end -->",
  "",
].join("\n");

function entriesWithMarker(list: HookEntry[] | undefined, cmdPart: string): boolean {
  return !!list?.some((e) => (e.hooks ?? []).some((h) => h.command.includes(MARKER) && h.command.includes(cmdPart)));
}

// Atomic install: tính nội dung AGENTS.md + kiểm tra marker TRƯỚC khi mutate hooks.json.
// Trả về nội dung cần ghi vào AGENTS.md, hoặc null nếu không cần ghi (đã có section).
function prepareInstruction(root: string): string | null {
  const file = join(root, "AGENTS.md");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes("<!-- ai-guard:start -->")) return null;
  return current + (current && !current.endsWith("\n") ? "\n" : "") + INSTRUCTION;
}

export const codexAdapter: AdapterBase = {
  id: "codex",
  label: "Codex CLI",
  detect: (root) => existsSync(join(root, ".codex")),
  install(root: string, opts: InstallOptions): InstallResult {
    try {
      const file = join(root, ".codex", "hooks.json");
      const cfg = readJson<CodexHooks>(file, {});
      cfg.hooks ??= {};
      cfg.hooks.UserPromptSubmit ??= [];
      cfg.hooks.PreToolUse ??= [];
      if (!entriesWithMarker(cfg.hooks.UserPromptSubmit, "check-prompt")) {
        cfg.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: CMD_PROMPT }] });
      }
      if (!entriesWithMarker(cfg.hooks.PreToolUse, "check-file")) {
        cfg.hooks.PreToolUse.push({ matcher: FILE_MATCHER, hooks: [{ type: "command", command: CMD_FILE }] });
      }
      const instruction = opts.instructions ? prepareInstruction(root) : null;
      writeJson(file, cfg);
      if (instruction !== null) writeFileSync(join(root, "AGENTS.md"), instruction);
      return { adapter: "codex", ok: true, detail: "hooks UserPromptSubmit + PreToolUse đã đăng ký" };
    } catch (e) {
      return { adapter: "codex", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      const file = join(root, ".codex", "hooks.json");
      if (!existsSync(file)) return { adapter: "codex", ok: true, detail: "không có hooks.json — không có gì để gỡ" };
      const cfg = readJson<CodexHooks>(file, {});
      if (cfg.hooks) {
        for (const ev of Object.keys(cfg.hooks)) {
          cfg.hooks[ev] = (cfg.hooks[ev] ?? []).filter((e) => !(e.hooks ?? []).some((h) => h.command.includes(MARKER)));
          if (cfg.hooks[ev].length === 0) delete cfg.hooks[ev];
        }
        if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
      }
      writeJson(file, cfg);
      return { adapter: "codex", ok: true, detail: "hooks ai-guard đã gỡ" };
    } catch (e) {
      return { adapter: "codex", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const cfg = readJson<CodexHooks>(join(root, ".codex", "hooks.json"), {});
    const ok = entriesWithMarker(cfg.hooks?.UserPromptSubmit, "check-prompt")
      && entriesWithMarker(cfg.hooks?.PreToolUse, "check-file");
    return { ok, detail: ok ? "hooks đã đăng ký" : "thiếu hook ai-guard trong .codex/hooks.json" };
  },
};
