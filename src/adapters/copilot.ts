import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, removeMarkedSection, SECTION_MARKER, templatePath } from "./hooks-json";

// GitHub Copilot (VS Code + CLI) — primary education layer + unified hook file.
// Step 0 verified (docs.github.com/en/copilot/reference/hooks-reference, Oct 2026):
// Copilot CLI + VS Code read repo-level `.github/hooks/*.json` as { "version": 1, hooks }
// — PascalCase events (PreToolUse) use Claude matcher semantics + snake_case payload
// (tool_name/tool_input — already parsed by the check-file extractor), exit 2 = DENY on CLI
// (fail-closed; only a timeout fails open), blocking error in VS Code agent mode.
// LIMITATION (platform, docs reference): userPromptSubmitted CANNOT block — exit 2 only
// surfaces stderr as a warning, the prompt still reaches the model (check-prompt --warn-only:
// audit 'warned' + stderr warning). The education layer (.github/copilot-instructions.md)
// remains the primary prompt layer.
const HOOK_REL = join(".github", "hooks", "ai-guard.json");
const INSTR_REL = join(".github", "copilot-instructions.md");

// Kill-switch: schema verified in Step 0; if VS Code changes the format and the hook causes errors -> set false,
// install still writes the education layer and the detail states it cannot block (platform limitation).
const REGISTER_HOOK = true;

// Unified format: "version": 1 is required by Copilot CLI; VS Code reads the same file.
// PreToolUse (PascalCase) -> payload tool_name/tool_input (already parsed), exit 2 = deny/block.
// userPromptSubmitted (camelCase CLI event) -> warn-only (platform does not allow blocking).
const HOOK_BODY =
  JSON.stringify(
    {
      version: 1,
      hooks: {
        PreToolUse: [
          { type: "command", command: "npx --no-install ai-guard check-file --tool copilot", timeoutSec: 30 }, // npx fallback ~6-10s on first run — 30s headroom, docs default 30
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
  // A Copilot CLI project may have NO .vscode — also detect via our own artifacts
  // (hook file with marker / instructions with section), otherwise doctor reports "No adapters
  // detected", misleadingly suggesting hooks are not installed for CLI-only users.
  detect: (root) =>
    existsSync(join(root, ".vscode")) ||
    (existsSync(join(root, HOOK_REL)) && readFileSync(join(root, HOOK_REL), "utf8").includes(MARKER)) ||
    (existsSync(join(root, INSTR_REL)) && readFileSync(join(root, INSTR_REL), "utf8").includes(SECTION_MARKER)),
  install(root: string, opts: InstallOptions): InstallResult {
    try {
      // Atomic install: check the hook slot + compute education content BEFORE mutating any file.
      // `.github/hooks/` allows multiple hook files, so ai-guard owns its own `ai-guard.json`;
      // a foreign file (no marker) occupying the slot -> refuse to overwrite.
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
      // Hook: file fully owned by ai-guard — delete only when the marker is present.
      const hookPath = join(root, HOOK_REL);
      let removedHook = false;
      if (existsSync(hookPath) && readFileSync(hookPath, "utf8").includes(MARKER)) {
        rmSync(hookPath);
        removedHook = true;
      }
      // Instructions: remove the marker-guarded section, KEEP user content; if nothing remains
      // after removal (file was created solely by ai-guard) -> delete the file too.
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
      } catch { /* corrupt JSON -> empty entries -> outdated */ }
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
