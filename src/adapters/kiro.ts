import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, templatePath } from "./hooks-json";

// Kiro — prompt-blocking hook (user-verified) + tool-blocking hook (IDE >= 1.0.116) + education layer (steering).
// Step 0 verified (kiro.dev/docs/hooks): hooks are JSON files under `.kiro/hooks/`, schema
// { version: "v1", hooks: [{ name, description?, trigger (PascalCase, e.g. "PreToolUse"),
// matcher? (regex matched against the tool name), action: { type: "command" | "agent", command | prompt },
// timeout? }] }. Command actions run at the project root and receive session context JSON on stdin.
// USER-VERIFIED (hand test on real Kiro): trigger "UserPromptSubmit" + command action
// WORKS — the stdin payload carries the prompt text (found under alias keys prompt|userPrompt|message|
// text|input|content — see extractPrompt) and exit 2 BLOCKS the prompt before it reaches the model.
// FIXED UPSTREAM (github.com/kirodotdev/Kiro#7500): resolved in Kiro IDE v1.0.116
// (Jul 2026) (fix confirmed in-thread; issue still open) — PreToolUse command hooks RECEIVE the tool payload (stdin has tool context),
// exit 2 blocks the tool call. Older IDEs (< 1.0.116) pass an empty stdin -> check-file
// finds no path -> exit 0 (fail-open). Prompt side: regression #10346 (UserPromptSubmit
// received an empty prompt in 1.0.138–1.0.242) fixed in 1.0.293 — recommend IDE >= 1.0.293.
//
// Kiro CLI:
// - CLI 3.x loads the same standalone `.kiro/hooks/*.json` files at session start. Payload is
//   { hook_event_name, cwd, session_id, tool_name, tool_input }; fs_read sends its paths as
//   tool_input.operations[].path (handled in check-file). NOTE: on CLI 3.x a PreToolUse hook that
//   exits with anything other than 0/2 (crash, timeout, missing binary) FAILS CLOSED and blocks the tool.
// - CLI 2.x does NOT read `.kiro/hooks/*.json` — hooks there live only inside agent configs
//   (`.kiro/agents/*.json`, object keyed by camelCase triggers, e.g. hooks.preToolUse[]). This
//   adapter therefore has no effect on CLI 2.x (no hook fires; steering still applies).
const HOOK_REL = join(".kiro", "hooks", "ai-guard.json");
const STEERING_REL = join(".kiro", "steering", "security.md");

// `matcher` omitted (optional): it matches tool names, which Kiro's docs did not pin down at the time —
// no matcher = fires on EVERY tool use, the widest coverage across all tools.
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
          timeout: 30, // npx fallback may take ~6-10s on first run — default 60 is excessive, 15 is too tight
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

// Tool side REALLY blocks on IDE >= 1.0.116 (#7500 fixed); older IDEs fail open (empty stdin).
const TOOL_SIDE_NOTE = "tool-side blocking works on IDE >= 1.0.116 (kirodotdev/Kiro#7500 fixed); older IDEs pass an empty payload (fail-open)";

export const kiroAdapter: AdapterBase = {
  id: "kiro",
  label: "Kiro",
  detect: (root) => existsSync(join(root, ".kiro")),
  install(root: string, opts: InstallOptions): InstallResult {
    try {
      // Atomic install: check the hook slot BEFORE mutating any file. `.kiro/hooks/` allows
      // multiple hook files, so ai-guard owns its own `ai-guard.json` (no merging JSON into the
      // user's files); a foreign file (no marker) occupying the slot -> refuse to overwrite.
      const hookPath = join(root, HOOK_REL);
      if (existsSync(hookPath) && !readFileSync(hookPath, "utf8").includes(MARKER)) {
        return { adapter: "kiro", ok: false, detail: `${HOOK_REL} exists but does not belong to ai-guard — not overwriting` };
      }
      // Education layer (always the primary layer on Kiro): marker-guarded steering append.
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
      // Only delete our own file: a foreign hook (no marker) at that exact path is left untouched.
      if (!readFileSync(hookPath, "utf8").includes(MARKER)) {
        return { adapter: "kiro", ok: true, detail: "hook file does not belong to ai-guard — not removing" };
      }
      rmSync(hookPath);
      // KEEP .kiro/steering/security.md (education) — controller decision: same as claude-code
      // keeping CLAUDE.md and shim adapters keeping AGENTS.md on uninstall (consistent + avoids losing
      // user content written around our section).
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
    // Ok requires BOTH triggers: UserPromptSubmit (check-prompt — prompt blocking) AND
    // PreToolUse (check-file — tool side). Old files with only PreToolUse (<=1.0.x) or
    // missing an entry -> re-run install.
    let entries: Array<{ trigger?: unknown; action?: { command?: unknown } }> = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.hooks)) entries = parsed.hooks;
    } catch { /* broken JSON -> empty entries -> both missing */ }
    const has = (trigger: string, cmdPart: string) =>
      entries.some(
        (h) => h?.trigger === trigger && typeof h?.action?.command === "string" && h.action.command.includes(cmdPart),
      );
    const promptHook = has("UserPromptSubmit", "check-prompt --tool kiro");
    const toolHook = has("PreToolUse", "check-file --tool kiro");
    // Steering is the primary education layer on Kiro — report its status in detail (does not
    // change ok-logic; hooks remain the ok criterion, as in other adapters).
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
