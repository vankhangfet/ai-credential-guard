import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, removeMarkedSection, SECTION_MARKER, templatePath } from "./hooks-json";

// GitHub Copilot (VS Code) — education layer chính + project-level agent hook.
// Step 0 verified (code.visualstudio.com/docs/agent-customization/hooks +
// /docs/agents/reference/hooks-reference): VS Code Local harness đọc hook files workspace-scope
// từ `.github/hooks/*.json` (setting `chat.useHooks` — ON mặc định). Format:
// { hooks: { PreToolUse: [ { type: "command", command, timeout } ] } }; PreToolUse stdin có
// tool_name + tool_input (đầy đủ, khác Kiro), exit 2 = blocking error (stderr tới model) ->
// check-file chặn được tool-side như Claude Code.
// GIỚI HẠN: Copilot chat mode (Agent Host) có hook implementation riêng, không đọc các file
// này; prompt-side KHÔNG chặn được -> education layer (.github/copilot-instructions.md, Copilot
// nạp như instructions) vẫn là lớp chính. Hook chỉ chắc chắn chạy cho agent mode Local.
const HOOK_REL = join(".github", "hooks", "ai-guard.json");
const INSTR_REL = join(".github", "copilot-instructions.md");

// Kill-switch: schema đã verify ở Step 0; nếu VS Code đổi format và hook gây lỗi -> đặt false,
// install vẫn ghi education layer và detail sẽ nêu rõ không chặn được (giới hạn nền tảng).
const REGISTER_HOOK = true;

const HOOK_BODY =
  JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          { type: "command", command: "npx --no-install ai-guard check-file --tool copilot", timeout: 15 },
        ],
      },
    },
    null,
    2,
  ) + "\n";

export const copilotAdapter: AdapterBase = {
  id: "copilot",
  label: "GitHub Copilot",
  detect: (root) => existsSync(join(root, ".vscode")),
  install(root: string, opts: InstallOptions): InstallResult {
    try {
      // Atomic install: kiểm tra slot hook + tính education TRƯỚC khi mutate file nào.
      // `.github/hooks/` cho phép nhiều hook files nên ai-guard sở hữu file `ai-guard.json`
      // riêng; file lạ (không marker) chiếm slot -> từ chối ghi đè.
      const hookPath = join(root, HOOK_REL);
      if (REGISTER_HOOK && existsSync(hookPath) && !readFileSync(hookPath, "utf8").includes(MARKER)) {
        return { adapter: "copilot", ok: false, detail: `${HOOK_REL} tồn tại nhưng không phải của ai-guard — không ghi đè` };
      }
      const instruction = opts.instructions
        ? appendMarkedSection(
            join(root, INSTR_REL),
            readFileSync(templatePath(
              join(__dirname, "..", "..", "templates", "copilot-instructions-main.md"),
              join(__dirname, "..", "..", "..", "templates", "copilot-instructions-main.md"),
            ), "utf8"),
          )
        : null;
      if (REGISTER_HOOK) {
        mkdirSync(dirname(hookPath), { recursive: true });
        writeFileSync(hookPath, HOOK_BODY);
      }
      if (instruction !== null) {
        mkdirSync(dirname(join(root, INSTR_REL)), { recursive: true });
        writeFileSync(join(root, INSTR_REL), instruction);
      }
      return {
        adapter: "copilot",
        ok: true,
        detail: REGISTER_HOOK
          ? `hook PreToolUse (${HOOK_REL}, agent mode) + education layer ${INSTR_REL} — instructions là lớp chính`
          : `education layer ${INSTR_REL} — KHÔNG chặn được prompt (giới hạn nền tảng)`,
      };
    } catch (e) {
      return { adapter: "copilot", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      // Hook: file hoàn toàn của ai-guard — chỉ xóa khi có marker.
      const hookPath = join(root, HOOK_REL);
      let removedHook = false;
      if (existsSync(hookPath) && readFileSync(hookPath, "utf8").includes(MARKER)) {
        rmSync(hookPath);
        removedHook = true;
      }
      // Instructions: bỏ section marker-guarded, GIỮ content user; nếu sau khi bỏ section không
      // còn gì (file vốn chỉ do ai-guard tạo) -> xóa luôn file.
      const instrPath = join(root, INSTR_REL);
      const rest = removeMarkedSection(instrPath);
      let instrDetail: string;
      if (rest === null) {
        instrDetail = "không có section ai-guard trong copilot-instructions.md";
      } else if (rest.trim() === "") {
        rmSync(instrPath);
        instrDetail = `đã xóa ${INSTR_REL} (chỉ còn section ai-guard)`;
      } else {
        writeFileSync(instrPath, rest.trimEnd() + "\n");
        instrDetail = `đã bỏ section ai-guard khỏi ${INSTR_REL}, giữ content user`;
      }
      return {
        adapter: "copilot",
        ok: true,
        detail: `${removedHook ? "hook đã gỡ" : "không có hook"}; ${instrDetail}`,
      };
    } catch (e) {
      return { adapter: "copilot", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const instrPath = join(root, INSTR_REL);
    const hookPath = join(root, HOOK_REL);
    const hasInstr = existsSync(instrPath) && readFileSync(instrPath, "utf8").includes(SECTION_MARKER);
    const hookDetail = existsSync(hookPath)
      ? (readFileSync(hookPath, "utf8").includes(MARKER) ? "hook PreToolUse đã cài" : "hook file không phải của ai-guard")
      : "không có hook";
    return {
      ok: hasInstr,
      detail: hasInstr
        ? `education layer ${INSTR_REL} đã cài (${hookDetail}; không chặn được prompt-side — giới hạn nền tảng)`
        : `thiếu education layer ${INSTR_REL} (${hookDetail})`,
    };
  },
};
