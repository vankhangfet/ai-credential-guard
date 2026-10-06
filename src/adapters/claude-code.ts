import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { readJson, writeJson } from "../util/json-config";
import { appendMarkedSection, entriesWithMarker, stripMarkerEntries, templatePath, type HookEntry } from "./hooks-json";

interface ClaudeSettings { permissions?: unknown; hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

const CMD_PROMPT = "npx --no-install ai-guard check-prompt --tool claude-code";
const CMD_FILE = "npx --no-install ai-guard check-file --tool claude-code";

export const claudeCodeAdapter: AdapterBase = {
  id: "claude-code",
  label: "Claude Code",
  detect: (root) => existsSync(join(root, ".claude")),
  install(root: string, opts: InstallOptions): InstallResult {
    try {
      const file = join(root, ".claude", "settings.json");
      const settings = readJson<ClaudeSettings>(file, {});
      settings.hooks ??= {};
      settings.hooks.UserPromptSubmit ??= [];
      settings.hooks.PreToolUse ??= [];
      if (!entriesWithMarker(settings.hooks.UserPromptSubmit, "check-prompt")) {
        settings.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: CMD_PROMPT }] });
      }
      if (!entriesWithMarker(settings.hooks.PreToolUse, "check-file")) {
        settings.hooks.PreToolUse.push({ matcher: "Read|Glob|Grep", hooks: [{ type: "command", command: CMD_FILE }] });
      }
      // Atomic install: tính nội dung CLAUDE.md TRƯỚC khi mutate settings.json.
      const instruction = opts.instructions
        ? appendMarkedSection(
            join(root, "CLAUDE.md"),
            readFileSync(templatePath(
              join(__dirname, "..", "..", "templates", "claude-instructions.md"),
              join(__dirname, "..", "..", "..", "templates", "claude-instructions.md"),
            ), "utf8"),
          )
        : null;
      writeJson(file, settings);
      if (instruction !== null) writeFileSync(join(root, "CLAUDE.md"), instruction);
      return { adapter: "claude-code", ok: true, detail: "hooks UserPromptSubmit + PreToolUse đã đăng ký" };
    } catch (e) {
      return { adapter: "claude-code", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      const file = join(root, ".claude", "settings.json");
      if (!existsSync(file)) return { adapter: "claude-code", ok: true, detail: "không có settings.json — không có gì để gỡ" };
      const settings = readJson<ClaudeSettings>(file, {});
      if (settings.hooks) {
        for (const ev of Object.keys(settings.hooks)) {
          const kept = stripMarkerEntries(settings.hooks[ev] ?? []);
          if (kept.length === 0) delete settings.hooks[ev];
          else settings.hooks[ev] = kept;
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeJson(file, settings);
      return { adapter: "claude-code", ok: true, detail: "hooks ai-guard đã gỡ" };
    } catch (e) {
      return { adapter: "claude-code", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const settings = readJson<ClaudeSettings>(join(root, ".claude", "settings.json"), {});
    const ok = entriesWithMarker(settings.hooks?.UserPromptSubmit, "check-prompt")
      && entriesWithMarker(settings.hooks?.PreToolUse, "check-file");
    return { ok, detail: ok ? "hooks đã đăng ký" : "thiếu hook ai-guard trong .claude/settings.json" };
  },
};
