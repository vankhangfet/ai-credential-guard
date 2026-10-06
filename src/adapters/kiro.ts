import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, templatePath } from "./hooks-json";

// Kiro — best-effort hook + education layer (steering).
// Step 0 verified (kiro.dev/docs/hooks): hooks là các JSON file trong `.kiro/hooks/`, schema
// { version: "v1", hooks: [{ name, description?, trigger (PascalCase, vd "PreToolUse"),
// matcher? (regex khớp tool name), action: { type: "command" | "agent", command | prompt },
// timeout? }] }. Command action chạy tại project root, nhận session context JSON trên stdin.
// GIỚI HẠN ĐÃ XÁC NHẬN (github.com/kirodotdev/Kiro#7500): runCommand hooks trong Kiro IDE
// KHÔNG nhận tool_name/tool_input (stdin rỗng, không env) — chỉ Kiro CLI truyền payload đầy
// đủ. CLI check-file không thấy path -> exit 0 (fail-open). Vậy hook là best-effort; steering
// (.kiro/steering/*.md, được Kiro nạp vào agent context) là lớp chính. Install/doctor detail
// LUÔN nêu rõ "best-effort".
const HOOK_REL = join(".kiro", "hooks", "ai-guard.json");
const STEERING_REL = join(".kiro", "steering", "security.md");

// Bỏ `matcher` (optional): matcher khớp tool name mà tên tool của Kiro chưa được docs cố định —
// không matcher = fires trên MỌI tool use, phủ widest cho best-effort.
const HOOK_BODY =
  JSON.stringify(
    {
      version: "v1",
      hooks: [
        {
          name: "ai-guard-check-file",
          description: "ai-guard (best-effort): chặn đọc credential — payload IDE có thể thiếu tool_input (kirodotdev/Kiro#7500)",
          trigger: "PreToolUse",
          action: { type: "command", command: "npx --no-install ai-guard check-file --tool kiro" },
          timeout: 30, // npx fallback có thể mất ~6-10s lần đầu — default 60 là dư, 15 là chặt
        },
      ],
    },
    null,
    2,
  ) + "\n";

const BEST_EFFORT = "best-effort — payload Kiro có thể thiếu tool_input (kirodotdev/Kiro#7500)";

export const kiroAdapter: AdapterBase = {
  id: "kiro",
  label: "Kiro",
  detect: (root) => existsSync(join(root, ".kiro")),
  install(root: string, opts: InstallOptions): InstallResult {
    try {
      // Atomic install: kiểm tra slot hook TRƯỚC khi mutate file nào. `.kiro/hooks/` cho phép
      // nhiều hook files nên ai-guard sở hữu file `ai-guard.json` riêng (không merge JSON vào
      // file user); file lạ (không marker) chiếm slot -> từ chối ghi đè.
      const hookPath = join(root, HOOK_REL);
      if (existsSync(hookPath) && !readFileSync(hookPath, "utf8").includes(MARKER)) {
        return { adapter: "kiro", ok: false, detail: `${HOOK_REL} tồn tại nhưng không phải của ai-guard — không ghi đè` };
      }
      // Education layer (luôn là lớp chính trên Kiro): steering marker-guarded append.
      const steering = opts.instructions
        ? appendMarkedSection(
            join(root, STEERING_REL),
            readFileSync(templatePath(
              join(__dirname, "..", "..", "templates", "kiro-steering.md"),
              join(__dirname, "..", "..", "..", "templates", "kiro-steering.md"),
            ), "utf8"),
          )
        : null;
      mkdirSync(dirname(hookPath), { recursive: true });
      writeFileSync(hookPath, HOOK_BODY);
      if (steering !== null) {
        mkdirSync(dirname(join(root, STEERING_REL)), { recursive: true });
        writeFileSync(join(root, STEERING_REL), steering);
      }
      return {
        adapter: "kiro",
        ok: true,
        detail: `hook PreToolUse best-effort (${HOOK_REL}) + education layer ${STEERING_REL} — steering là lớp chính`,
      };
    } catch (e) {
      return { adapter: "kiro", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      const hookPath = join(root, HOOK_REL);
      if (!existsSync(hookPath)) {
        return { adapter: "kiro", ok: true, detail: "không có hook ai-guard — không có gì để gỡ" };
      }
      // Chỉ xóa file của mình: hook lạ (không marker) tại đúng path đó thì giữ nguyên.
      if (!readFileSync(hookPath, "utf8").includes(MARKER)) {
        return { adapter: "kiro", ok: true, detail: "file hook không phải của ai-guard — không xóa" };
      }
      rmSync(hookPath);
      // GIỮ .kiro/steering/security.md (education) — quyết định controller: giữ như claude-code
      // đang giữ CLAUDE.md và shim adapters giữ AGENTS.md khi uninstall (nhất quán + tránh mất
      // content user đã viết quanh section của ta).
      return { adapter: "kiro", ok: true, detail: `hook ai-guard đã gỡ (${STEERING_REL} giữ nguyên)` };
    } catch (e) {
      return { adapter: "kiro", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const hookPath = join(root, HOOK_REL);
    if (!existsSync(hookPath)) {
      return { ok: false, detail: `thiếu hook ai-guard: ${HOOK_REL} (${BEST_EFFORT})` };
    }
    const ours = readFileSync(hookPath, "utf8").includes(MARKER);
    // Steering là lớp chính trên Kiro — nêu trạng thái trong detail (không đổi ok-logic,
    // hook vẫn là mốc ok như các adapter khác).
    const steeringNote = existsSync(join(root, STEERING_REL))
      ? " + steering security.md"
      : " (thiếu steering — chạy lại install với instructions)";
    return {
      ok: ours,
      detail: ours
        ? `hook PreToolUse đã cài${steeringNote} (${BEST_EFFORT})`
        : `${HOOK_REL} tồn tại nhưng không phải của ai-guard (${BEST_EFFORT})`,
    };
  },
};
