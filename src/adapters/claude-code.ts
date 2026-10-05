import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER, readJson, writeJson } from "../util/json-config";

interface HookEntry { matcher?: string; hooks: Array<{ type: string; command: string }> }
interface ClaudeSettings { permissions?: unknown; hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

const CMD_PROMPT = "npx --no-install ai-guard check-prompt --tool claude-code";
const CMD_FILE = "npx --no-install ai-guard check-file --tool claude-code";

function entriesWithMarker(list: HookEntry[] | undefined, cmdPart: string): boolean {
  return !!list?.some((e) => e.hooks.some((h) => h.command.includes(MARKER) && h.command.includes(cmdPart)));
}

// src: <repo>/src/adapters -> ../../templates; dist: <pkg>/dist/adapters -> ../../templates.
// Fallback ../../../templates cho layout thay thế (vd. dist bundled sâu hơn một tầng).
function templatePath(): string {
  const primary = join(__dirname, "..", "..", "templates", "claude-instructions.md");
  if (existsSync(primary)) return primary;
  return join(__dirname, "..", "..", "..", "templates", "claude-instructions.md");
}

function appendInstruction(root: string): void {
  const file = join(root, "CLAUDE.md");
  const template = readFileSync(templatePath(), "utf8");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes("<!-- ai-guard:start -->")) return;
  writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + template);
}

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
      writeJson(file, settings);
      if (opts.instructions) appendInstruction(root);
      return { adapter: "claude-code", ok: true, detail: "hooks UserPromptSubmit + PreToolUse đã đăng ký" };
    } catch (e) {
      return { adapter: "claude-code", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      const file = join(root, ".claude", "settings.json");
      const settings = readJson<ClaudeSettings>(file, {});
      if (settings.hooks) {
        for (const ev of Object.keys(settings.hooks)) {
          settings.hooks[ev] = (settings.hooks[ev] ?? []).filter((e) => !e.hooks.some((h) => h.command.includes(MARKER)));
          if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
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
