import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, templatePath } from "./hooks-json";

// Kiro — prompt-blocking hook (user-verified) + tool-blocking hook (IDE >= 1.0.116) + education layer (steering).
// Step 0 verified (kiro.dev/docs/hooks): hooks là các JSON file trong `.kiro/hooks/`, schema
// { version: "v1", hooks: [{ name, description?, trigger (PascalCase, vd "PreToolUse"),
// matcher? (regex khớp tool name), action: { type: "command" | "agent", command | prompt },
// timeout? }] }. Command action chạy tại project root, nhận session context JSON trên stdin.
// USER-VERIFIED (hand test trên Kiro thật): trigger "UserPromptSubmit" + action command
// WORKS — payload stdin có prompt text (findable dưới alias keys prompt|userPrompt|message|
// text|input|content — xem extractPrompt) và exit 2 BLOCKS prompt trước khi tới model.
// ĐÃ FIX UPSTREAM (github.com/kirodotdev/Kiro#7500): resolved ở Kiro IDE v1.0.116
// (Jul 2026) (fix confirmed in-thread; issue still open) — PreToolUse command hooks NHẬN tool payload (stdin có tool context),
// exit 2 chặn tool call. IDE cũ hơn (< 1.0.116) truyền stdin rỗng -> check-file
// không thấy path -> exit 0 (fail-open). Prompt-side: regression #10346 (UserPromptSubmit
// nhận prompt rỗng ở 1.0.138–1.0.242) fixed ở 1.0.293 — khuyên dùng IDE >= 1.0.293.
const HOOK_REL = join(".kiro", "hooks", "ai-guard.json");
const STEERING_REL = join(".kiro", "steering", "security.md");

// Bỏ `matcher` (optional): matcher khớp tool name mà tên tool của Kiro chưa được docs cố định —
// không matcher = fires trên MỌI tool use, phủ widest cho mọi tool.
const HOOK_BODY =
  JSON.stringify(
    {
      version: "v1",
      hooks: [
        {
          name: "ai-guard prompt check",
          description: "Scans submitted prompts for credentials; exit 2 blocks the prompt before it reaches the model.",
          trigger: "UserPromptSubmit",
          action: { type: "command", command: "npx --no-install ai-guard check-prompt --tool kiro" },
          timeout: 30, // npx fallback có thể mất ~6-10s lần đầu — default 60 là dư, 15 là chặt
        },
        {
          name: "ai-guard-check-file",
          description: "ai-guard: block credential file reads — exit 2 blocks the tool call (IDE >= 1.0.116; older IDEs fail open, see kirodotdev/Kiro#7500)",
          trigger: "PreToolUse",
          action: { type: "command", command: "npx --no-install ai-guard check-file --tool kiro" },
          timeout: 30,
        },
      ],
    },
    null,
    2,
  ) + "\n";

// Tool side chặn THẬT trên IDE >= 1.0.116 (#7500 fixed); IDE cũ fail-open (stdin rỗng).
const TOOL_SIDE_NOTE = "tool-side blocking works on IDE >= 1.0.116 (kirodotdev/Kiro#7500 fixed); older IDEs pass an empty payload (fail-open)";

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
        return { adapter: "kiro", ok: false, detail: `${HOOK_REL} exists but does not belong to ai-guard — not overwriting` };
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
        detail: `hooks UserPromptSubmit (prompt, user-verified) + PreToolUse (${TOOL_SIDE_NOTE}) at ${HOOK_REL} + education layer ${STEERING_REL}`,
      };
    } catch (e) {
      return { adapter: "kiro", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      const hookPath = join(root, HOOK_REL);
      if (!existsSync(hookPath)) {
        return { adapter: "kiro", ok: true, detail: "no ai-guard hook — nothing to remove" };
      }
      // Chỉ xóa file của mình: hook lạ (không marker) tại đúng path đó thì giữ nguyên.
      if (!readFileSync(hookPath, "utf8").includes(MARKER)) {
        return { adapter: "kiro", ok: true, detail: "hook file does not belong to ai-guard — not removing" };
      }
      rmSync(hookPath);
      // GIỮ .kiro/steering/security.md (education) — quyết định controller: giữ như claude-code
      // đang giữ CLAUDE.md và shim adapters giữ AGENTS.md khi uninstall (nhất quán + tránh mất
      // content user đã viết quanh section của ta).
      return { adapter: "kiro", ok: true, detail: `ai-guard hook removed (${STEERING_REL} kept)` };
    } catch (e) {
      return { adapter: "kiro", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const hookPath = join(root, HOOK_REL);
    if (!existsSync(hookPath)) {
      return { ok: false, detail: `missing ai-guard hooks: ${HOOK_REL} — expected UserPromptSubmit (prompt) + PreToolUse (${TOOL_SIDE_NOTE})` };
    }
    const raw = readFileSync(hookPath, "utf8");
    if (!raw.includes(MARKER)) {
      return { ok: false, detail: `${HOOK_REL} exists but does not belong to ai-guard (${TOOL_SIDE_NOTE})` };
    }
    // Ok đòi hỏi ĐỦ 2 trigger: UserPromptSubmit (check-prompt — prompt blocking) VÀ
    // PreToolUse (check-file — tool side). File cũ chỉ có PreToolUse (<=1.0.x) hoặc
    // thiếu 1 entry -> re-run install.
    let entries: Array<{ trigger?: unknown; action?: { command?: unknown } }> = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.hooks)) entries = parsed.hooks;
    } catch { /* JSON hỏng -> entries rỗng -> missing cả 2 */ }
    const has = (trigger: string, cmdPart: string) =>
      entries.some(
        (h) => h?.trigger === trigger && typeof h?.action?.command === "string" && h.action.command.includes(cmdPart),
      );
    const promptHook = has("UserPromptSubmit", "check-prompt --tool kiro");
    const toolHook = has("PreToolUse", "check-file --tool kiro");
    // Steering là lớp education chính trên Kiro — nêu trạng thái trong detail (không đổi
    // ok-logic, hooks vẫn là mốc ok như các adapter khác).
    const steeringNote = existsSync(join(root, STEERING_REL))
      ? " + steering security.md"
      : " (missing steering — re-run install with instructions)";
    if (!promptHook || !toolHook) {
      const missing = [!promptHook && "UserPromptSubmit (check-prompt)", !toolHook && "PreToolUse (check-file)"]
        .filter(Boolean)
        .join(" + ");
      return { ok: false, detail: `${HOOK_REL} outdated — missing ${missing}; re-run install (${TOOL_SIDE_NOTE})` };
    }
    return {
      ok: true,
      detail: `hooks registered (prompt + tool; ${TOOL_SIDE_NOTE}; prompt-side: use IDE >= 1.0.293 (#10346 regression fixed))${steeringNote}`,
    };
  },
};
