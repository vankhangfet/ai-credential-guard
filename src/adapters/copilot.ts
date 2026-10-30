import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, removeMarkedSection, SECTION_MARKER, templatePath } from "./hooks-json";

// GitHub Copilot (VS Code + CLI) — education layer chính + unified hook file.
// Step 0 verified (docs.github.com/en/copilot/reference/hooks-reference, Oct 2026):
// Copilot CLI + VS Code đọc repo-level `.github/hooks/*.json` dạng { "version": 1, hooks }
// — event PascalCase (PreToolUse) dùng Claude matcher semantics + payload snake_case
// (tool_name/tool_input — extractor check-file đã parse), exit 2 = DENY trên CLI
// (fail-closed; chỉ timeout fail-open), blocking error trên VS Code agent mode.
// GIỚI HẠN (platform, docs reference): userPromptSubmitted KHÔNG chặn được — exit 2 chỉ
// surface stderr như warning, prompt vẫn tới model (check-prompt --warn-only: audit
// 'warned' + stderr warning). Education layer (.github/copilot-instructions.md) vẫn là
// lớp prompt chính.
const HOOK_REL = join(".github", "hooks", "ai-guard.json");
const INSTR_REL = join(".github", "copilot-instructions.md");

// Kill-switch: schema đã verify ở Step 0; nếu VS Code đổi format và hook gây lỗi -> đặt false,
// install vẫn ghi education layer và detail sẽ nêu rõ không chặn được (giới hạn nền tảng).
const REGISTER_HOOK = true;

// Unified format: "version": 1 required bởi Copilot CLI; VS Code đọc cùng file.
// PreToolUse (PascalCase) -> payload tool_name/tool_input (đã parse), exit 2 = deny/block.
// userPromptSubmitted (camelCase CLI event) -> warn-only (platform không cho block).
const HOOK_BODY =
  JSON.stringify(
    {
      version: 1,
      hooks: {
        PreToolUse: [
          { type: "command", command: "npx --no-install ai-guard check-file --tool copilot", timeoutSec: 30 }, // npx fallback ~6-10s lần đầu — 30s headroom, docs default 30
        ],
        userPromptSubmitted: [
          { type: "command", command: "npx --no-install ai-guard check-prompt --tool copilot --warn-only", timeoutSec: 30 },
        ],
      },
    },
    null,
    2,
  ) + "\n";

export const copilotAdapter: AdapterBase = {
  id: "copilot",
  label: "GitHub Copilot (VS Code + CLI)",
  // Copilot CLI project có thể KHÔNG có .vscode — detect thêm qua artifact của chính ta
  // (hook file có marker / instructions có section), nếu không doctor báo "No adapters
  // detected" gây hiểu lầm hook chưa cài trên đúng nhóm user mới (CLI-only).
  detect: (root) =>
    existsSync(join(root, ".vscode")) ||
    (existsSync(join(root, HOOK_REL)) && readFileSync(join(root, HOOK_REL), "utf8").includes(MARKER)) ||
    (existsSync(join(root, INSTR_REL)) && readFileSync(join(root, INSTR_REL), "utf8").includes(SECTION_MARKER)),
  install(root: string, opts: InstallOptions): InstallResult {
    try {
      // Atomic install: kiểm tra slot hook + tính education TRƯỚC khi mutate file nào.
      // `.github/hooks/` cho phép nhiều hook files nên ai-guard sở hữu file `ai-guard.json`
      // riêng; file lạ (không marker) chiếm slot -> từ chối ghi đè.
      const hookPath = join(root, HOOK_REL);
      if (REGISTER_HOOK && existsSync(hookPath) && !readFileSync(hookPath, "utf8").includes(MARKER)) {
        return { adapter: "copilot", ok: false, detail: `${HOOK_REL} exists but does not belong to ai-guard — not overwriting` };
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
          ? `hook PreToolUse + userPromptSubmitted warn-only (${HOOK_REL}, VS Code agent mode + Copilot CLI) + education layer ${INSTR_REL} — prompts cannot be blocked (platform limit), instructions are the primary prompt layer`
          : `education layer ${INSTR_REL} — prompt side cannot be blocked (platform limitation)`,
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
        instrDetail = "no ai-guard section in copilot-instructions.md";
      } else if (rest.trim() === "") {
        rmSync(instrPath);
        instrDetail = `deleted ${INSTR_REL} (only the ai-guard section remained)`;
      } else {
        writeFileSync(instrPath, rest.trimEnd() + "\n");
        instrDetail = `removed ai-guard section from ${INSTR_REL}, kept user content`;
      }
      return {
        adapter: "copilot",
        ok: true,
        detail: `${removedHook ? "hook removed" : "no hook"}; ${instrDetail}`,
      };
    } catch (e) {
      return { adapter: "copilot", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const instrPath = join(root, INSTR_REL);
    const hookPath = join(root, HOOK_REL);
    const hasInstr = existsSync(instrPath) && readFileSync(instrPath, "utf8").includes(SECTION_MARKER);
    let hookOk = false;
    let hookDetail: string;
    if (!existsSync(hookPath)) {
      hookDetail = "no hook — re-run install";
    } else if (!readFileSync(hookPath, "utf8").includes(MARKER)) {
      hookDetail = "hook file does not belong to ai-guard";
    } else {
      let version: unknown;
      let entries: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(readFileSync(hookPath, "utf8"));
        version = parsed?.version;
        if (parsed?.hooks && typeof parsed.hooks === "object") entries = parsed.hooks;
      } catch { /* JSON hỏng -> entries rỗng -> outdated */ }
      const hasEntry = (event: string, cmdPart: string) =>
        Array.isArray(entries[event]) &&
        (entries[event] as Array<{ command?: unknown }>).some(
          (h) => typeof h?.command === "string" && h.command.includes(cmdPart),
        );
      const blocking = hasEntry("PreToolUse", "check-file --tool copilot");
      const warnOnly = hasEntry("userPromptSubmitted", "check-prompt --tool copilot --warn-only");
      if (version === 1 && blocking && warnOnly) {
        hookOk = true;
        hookDetail = "hooks installed (PreToolUse blocks file reads; userPromptSubmitted warns — cannot block prompts, platform limit)";
      } else {
        const missing = [
          version !== 1 && '"version": 1',
          !blocking && "PreToolUse (check-file)",
          !warnOnly && "userPromptSubmitted (check-prompt, warn-only)",
        ].filter(Boolean).join(" + ");
        hookDetail = `hook outdated — missing ${missing}; re-run install`;
      }
    }
    const ok = hasInstr && (!REGISTER_HOOK || hookOk);
    return {
      ok,
      detail: hasInstr
        ? `education layer ${INSTR_REL} installed (${hookDetail})`
        : `missing education layer ${INSTR_REL} (${hookDetail})`,
    };
  },
};
