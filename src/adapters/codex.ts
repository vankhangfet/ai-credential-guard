import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { readJson, writeJson } from "../util/json-config";
import { appendMarkedSection, entriesWithMarker, stripMarkerEntries, templatePath, type HookEntry } from "./hooks-json";

interface CodexHooks { description?: string; hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

const CMD_PROMPT = "npx --no-install ai-guard check-prompt --tool codex";
const CMD_FILE = "npx --no-install ai-guard check-file --tool codex";

// Codex tool names (docs chính thức): file edits qua `apply_patch` (matcher nhận alias Edit|Write),
// MCP tools theo tên đầy đủ `mcp__filesystem__read_file`... — không có tool "read|grep|glob" lowercase.
const FILE_MATCHER = "Edit|Write|apply_patch|mcp__.*";

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
      // Atomic install: tính nội dung AGENTS.md TRƯỚC khi mutate hooks.json.
      const instruction = opts.instructions
        ? appendMarkedSection(
            join(root, "AGENTS.md"),
            readFileSync(templatePath(
              join(__dirname, "..", "..", "templates", "codex-instructions.md"),
              join(__dirname, "..", "..", "..", "templates", "codex-instructions.md"),
            ), "utf8"),
          )
        : null;
      writeJson(file, cfg);
      if (instruction !== null) writeFileSync(join(root, "AGENTS.md"), instruction);
      return { adapter: "codex", ok: true, detail: "hooks UserPromptSubmit + PreToolUse registered" };
    } catch (e) {
      return { adapter: "codex", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      const file = join(root, ".codex", "hooks.json");
      if (!existsSync(file)) return { adapter: "codex", ok: true, detail: "no hooks.json — nothing to remove" };
      const cfg = readJson<CodexHooks>(file, {});
      if (cfg.hooks) {
        for (const ev of Object.keys(cfg.hooks)) {
          const kept = stripMarkerEntries(cfg.hooks[ev] ?? []);
          if (kept.length === 0) delete cfg.hooks[ev];
          else cfg.hooks[ev] = kept;
        }
        if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
      }
      writeJson(file, cfg);
      return { adapter: "codex", ok: true, detail: "ai-guard hooks removed" };
    } catch (e) {
      return { adapter: "codex", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const cfg = readJson<CodexHooks>(join(root, ".codex", "hooks.json"), {});
    const ok = entriesWithMarker(cfg.hooks?.UserPromptSubmit, "check-prompt")
      && entriesWithMarker(cfg.hooks?.PreToolUse, "check-file");
    return { ok, detail: ok ? "hooks registered" : "missing ai-guard hook in .codex/hooks.json" };
  },
};
