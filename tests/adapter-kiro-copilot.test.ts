import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { kiroAdapter } from "../src/adapters/kiro";
import { copilotAdapter } from "../src/adapters/copilot";

// Step 0 (verified):
//  - Kiro (kiro.dev/docs/hooks): hooks = JSON files in `.kiro/hooks/`, schema
//    { version: "v1", hooks: [{ name, trigger, action: { type: "command", command } }] }.
//    USER-VERIFIED: trigger "UserPromptSubmit" + command action WORKS — stdin payload has
//    prompt text (alias keys prompt|userPrompt|message|text|input|content) and exit 2
//    BLOCKS prompt. FIXED (kirodotdev/Kiro#7500): since IDE >= 1.0.116 PreToolUse command
//    hooks RECEIVE tool_input -> exit 2 really blocks the tool call (tool side); older IDEs fail-open.
//  - Copilot/VS Code (code.visualstudio.com/docs/agent-customization/hooks): project-level hooks
//    exist — `.github/hooks/*.json` (Local harness; chat.useHooks only gates the legacy Local harness; repo .github/hooks is loaded by the shared Copilot runtime), PreToolUse stdin
//    has tool_input, exit 2 = block. Chat/prompt-side CANNOT block -> education layer is primary.
const KIRO_HOOK = join(".kiro", "hooks", "ai-guard.json");
const KIRO_STEERING = join(".kiro", "steering", "security.md");
const COPILOT_HOOK = join(".github", "hooks", "ai-guard.json");
const COPILOT_INSTR = join(".github", "copilot-instructions.md");

describe("kiro adapter (prompt-blocking hook + tool-blocking hook (IDE >= 1.0.116) + steering education)", () => {
  it("detect .kiro dir", () => {
    expect(kiroAdapter.detect(mkproject({ kiro: true }))).toBe(true);
    expect(kiroAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install creates UserPromptSubmit + PreToolUse hooks + steering; idempotent; detail mentions both hooks", () => {
    const root = mkproject({ kiro: true });
    const r = kiroAdapter.install(root, { instructions: true });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("1.0.116");
    expect(r.detail).toContain("UserPromptSubmit");
    const hook = JSON.parse(readFileSync(join(root, KIRO_HOOK), "utf8"));
    expect(hook.version).toBe("v1");
    expect(hook.hooks).toHaveLength(2);
    const triggers = hook.hooks.map((h: any) => h.trigger);
    expect(triggers).toContain("UserPromptSubmit");
    expect(triggers).toContain("PreToolUse");
    const byTrigger = Object.fromEntries(hook.hooks.map((h: any) => [h.trigger, h]));
    expect(byTrigger.UserPromptSubmit.action.type).toBe("command");
    expect(byTrigger.UserPromptSubmit.action.command).toContain("check-prompt --tool kiro");
    expect(byTrigger.PreToolUse.action.command).toContain("check-file --tool kiro");
    expect(readFileSync(join(root, KIRO_STEERING), "utf8")).toContain("ai-guard:start");
    // idempotent: re-running does not duplicate hooks/sections
    kiroAdapter.install(root, { instructions: true });
    expect(JSON.parse(readFileSync(join(root, KIRO_HOOK), "utf8")).hooks).toHaveLength(2);
    expect((readFileSync(join(root, KIRO_STEERING), "utf8").match(/ai-guard:start/g) ?? []).length).toBe(1);
  });
  it("install --no-instructions writes hooks only; foreign hook occupying slot -> refused (atomic, no steering written)", () => {
    const root = mkproject({ kiro: true });
    expect(kiroAdapter.install(root, { instructions: false }).ok).toBe(true);
    expect(existsSync(join(root, KIRO_STEERING))).toBe(false);
    const root2 = mkproject({ kiro: true });
    mkdirSync(join(root2, ".kiro", "hooks"), { recursive: true });
    writeFileSync(join(root2, KIRO_HOOK), JSON.stringify({
      version: "v1",
      hooks: [{ name: "mine", trigger: "PreToolUse", action: { type: "command", command: "echo hi" } }],
    }));
    const r2 = kiroAdapter.install(root2, { instructions: true });
    expect(r2.ok).toBe(false);
    expect(JSON.parse(readFileSync(join(root2, KIRO_HOOK), "utf8")).hooks[0].name).toBe("mine");
    expect(existsSync(join(root2, KIRO_STEERING))).toBe(false);
  });
  it("uninstall removes own hooks, KEEPS steering (education)", () => {
    const root = mkproject({ kiro: true });
    kiroAdapter.install(root, { instructions: true });
    expect(kiroAdapter.uninstall(root).ok).toBe(true);
    expect(existsSync(join(root, KIRO_HOOK))).toBe(false);
    expect(existsSync(join(root, KIRO_STEERING))).toBe(true);
  });
  it("doctor: fail before install; ok after install — detail mentions prompt + tool side (1.0.116)", () => {
    const root = mkproject({ kiro: true });
    const before = kiroAdapter.doctor(root);
    expect(before.ok).toBe(false);
    expect(before.detail).toContain("1.0.116");
    kiroAdapter.install(root, { instructions: false });
    const after = kiroAdapter.doctor(root);
    expect(after.ok).toBe(true);
    expect(after.detail).toContain("prompt");
    expect(after.detail).toContain("1.0.116");
    expect(after.detail).toContain("1.0.293");
    expect(after.detail).toContain("kirodotdev/Kiro#7500");
    // Fix 3 (coordinator): doctor reports steering status (ok-logic unchanged)
    expect(after.detail).toContain("missing steering");
    kiroAdapter.install(root, { instructions: true });
    expect(kiroAdapter.doctor(root).detail).toContain("steering security.md");
  });
  it("doctor: old hook file with only PreToolUse (missing UserPromptSubmit) -> not ok; re-install fixes", () => {
    const root = mkproject({ kiro: true });
    mkdirSync(join(root, ".kiro", "hooks"), { recursive: true });
    // format <=1.0.x: only ai-guard's PreToolUse entry (command has marker "ai-guard")
    writeFileSync(join(root, KIRO_HOOK), JSON.stringify(
      {
        version: "v1",
        hooks: [{ name: "ai-guard-check-file", trigger: "PreToolUse", action: { type: "command", command: "npx --no-install ai-guard check-file --tool kiro" } }],
      },
      null,
      2,
    ));
    const d = kiroAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("UserPromptSubmit");
    kiroAdapter.install(root, { instructions: false });
    expect(kiroAdapter.doctor(root).ok).toBe(true);
  });
});

describe("copilot adapter (education layer + agent hooks)", () => {
  it("detect .vscode dir", () => {
    expect(copilotAdapter.detect(mkproject({ vscode: true }))).toBe(true);
    expect(copilotAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install creates version:1 hook (blocking PreToolUse + warn-only userPromptSubmitted) + copilot-instructions; idempotent", () => {
    const root = mkproject({ vscode: true });
    const r = copilotAdapter.install(root, { instructions: true });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("education layer");
    expect(r.detail).toContain("warn-only");
    const hook = JSON.parse(readFileSync(join(root, COPILOT_HOOK), "utf8"));
    expect(hook.version).toBe(1);
    expect(hook.hooks.PreToolUse).toHaveLength(1);
    expect(hook.hooks.PreToolUse[0].command).toContain("check-file --tool copilot");
    expect(hook.hooks.userPromptSubmitted).toHaveLength(1);
    expect(hook.hooks.userPromptSubmitted[0].command).toContain("check-prompt --tool copilot");
    expect(hook.hooks.userPromptSubmitted[0].command).toContain("--warn-only");
    expect(readFileSync(join(root, COPILOT_INSTR), "utf8")).toContain("ai-guard:start");
    copilotAdapter.install(root, { instructions: true });
    expect(JSON.parse(readFileSync(join(root, COPILOT_HOOK), "utf8")).hooks.PreToolUse).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, COPILOT_HOOK), "utf8")).hooks.userPromptSubmitted).toHaveLength(1);
    expect((readFileSync(join(root, COPILOT_INSTR), "utf8").match(/ai-guard:start/g) ?? []).length).toBe(1);
  });
  it("install --no-instructions writes hooks only (does not create copilot-instructions.md)", () => {
    const root = mkproject({ vscode: true });
    expect(copilotAdapter.install(root, { instructions: false }).ok).toBe(true);
    expect(existsSync(join(root, COPILOT_INSTR))).toBe(false);
    expect(existsSync(join(root, COPILOT_HOOK))).toBe(true);
  });
  it("uninstall: instructions file only ours -> deleted; has user content -> keep user part; removes hook", () => {
    // case 1: file created by us (only the ai-guard section) -> delete the file
    const root = mkproject({ vscode: true });
    copilotAdapter.install(root, { instructions: true });
    expect(copilotAdapter.uninstall(root).ok).toBe(true);
    expect(existsSync(join(root, COPILOT_INSTR))).toBe(false);
    expect(existsSync(join(root, COPILOT_HOOK))).toBe(false);
    // case 2: user has own content + our section -> remove section, keep user content
    const root2 = mkproject({ vscode: true });
    mkdirSync(join(root2, ".github"), { recursive: true });
    writeFileSync(join(root2, COPILOT_INSTR), "# Team rules\n\nAlways use pnpm.\n");
    copilotAdapter.install(root2, { instructions: true });
    expect(copilotAdapter.uninstall(root2).ok).toBe(true);
    const rest = readFileSync(join(root2, COPILOT_INSTR), "utf8");
    expect(rest).toContain("Always use pnpm.");
    expect(rest).not.toContain("ai-guard:start");
  });
  it("doctor: missing -> not ok; after install -> ok + states warn-only cannot block prompts", () => {
    const root = mkproject({ vscode: true });
    expect(copilotAdapter.doctor(root).ok).toBe(false);
    copilotAdapter.install(root, { instructions: true });
    const d = copilotAdapter.doctor(root);
    expect(d.ok).toBe(true);
    expect(d.detail).toContain("education layer");
    expect(d.detail).toContain("cannot block");
    expect(d.detail).toContain("warn");
  });
  it("doctor: legacy hook file (no version:1, no prompt entry) -> not ok, re-install fixes", () => {
    const root = mkproject({ vscode: true });
    mkdirSync(join(root, ".github", "hooks"), { recursive: true });
    // format <=1.1.x: PreToolUse only, no "version"
    writeFileSync(join(root, COPILOT_HOOK), JSON.stringify(
      { hooks: { PreToolUse: [{ type: "command", command: "npx --no-install ai-guard check-file --tool copilot" }] } },
      null,
      2,
    ));
    const d = copilotAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("re-run install");
    copilotAdapter.install(root, { instructions: true });
    expect(copilotAdapter.doctor(root).ok).toBe(true);
  });
  it("doctor: prompt entry missing --warn-only -> not ok (avoids false 'blocked' telemetry)", () => {
    const root = mkproject({ vscode: true });
    mkdirSync(join(root, ".github", "hooks"), { recursive: true });
    writeFileSync(join(root, COPILOT_HOOK), JSON.stringify(
      {
        version: 1,
        hooks: {
          PreToolUse: [{ type: "command", command: "npx --no-install ai-guard check-file --tool copilot" }],
          userPromptSubmitted: [{ type: "command", command: "npx --no-install ai-guard check-prompt --tool copilot" }],
        },
      },
      null,
      2,
    ) + "\n");
    const d = copilotAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("re-run install");
    copilotAdapter.install(root, { instructions: true });
    expect(copilotAdapter.doctor(root).ok).toBe(true);
  });
  it("doctor: corrupt JSON hook file (has marker) -> not ok, re-run install", () => {
    const root = mkproject({ vscode: true });
    mkdirSync(join(root, ".github", "hooks"), { recursive: true });
    writeFileSync(join(root, COPILOT_HOOK), '{ "ai-guard": tru'); // contains "ai-guard" (marker) but is unparseable
    const d = copilotAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("re-run install");
  });
  it("detect: Copilot CLI only (no .vscode) — detected via artifact, doctor green after install", () => {
    const root = mkproject({}); // NO .vscode
    expect(copilotAdapter.detect(root)).toBe(false);
    expect(copilotAdapter.install(root, { instructions: true }).ok).toBe(true);
    expect(copilotAdapter.detect(root)).toBe(true);
    expect(copilotAdapter.doctor(root).ok).toBe(true);
  });
  it("detect: only instructions artifact remains (hook deleted) -> still true", () => {
    const root = mkproject({});
    copilotAdapter.install(root, { instructions: true });
    rmSync(join(root, COPILOT_HOOK));
    expect(copilotAdapter.detect(root)).toBe(true);
  });
});
