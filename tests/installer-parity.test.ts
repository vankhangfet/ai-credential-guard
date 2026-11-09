// Drift cross-check (Task 26): adapter TS ↔ fallback installers (install.sh / install.ps1).
// Note: this is a pure drift check, NOT TDD — the installers are already in sync so it passes immediately;
// its value is as a regression lock: changing a matcher/command in one source and forgetting the other -> red here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeAdapter } from "../src/adapters/claude-code";
import { codexAdapter } from "../src/adapters/codex";
import { mkproject } from "./util/mkproject";

const sh = readFileSync(join(__dirname, "..", "fallback", "install.sh"), "utf8");
const ps1 = readFileSync(join(__dirname, "..", "fallback", "install.ps1"), "utf8");

// Read the ACTUAL PreToolUse matcher the adapter writes to config (not hardcoded in the test —
// if the adapter changes the matcher, this is the single source compared against the installers).
function fileMatcherOf(root: string, rel: string): string | undefined {
  const cfg = JSON.parse(readFileSync(join(root, rel), "utf8"));
  const entry = (cfg.hooks?.PreToolUse ?? []).find((e: unknown) =>
    JSON.stringify(e).includes("check-file"),
  );
  return entry?.matcher;
}

describe("installer parity (drift cross-check)", () => {
  it("claude-code matcher is in sync between the TS adapter and installers", () => {
    const root = mkproject({ claudeCode: true });
    expect(claudeCodeAdapter.install(root, { instructions: false }).ok).toBe(true);
    const matcher = fileMatcherOf(root, join(".claude", "settings.json"));
    expect(matcher).toBeTruthy();
    expect(sh).toContain(matcher!);
    expect(ps1).toContain(matcher!);
  });

  it("codex matcher is in sync between the TS adapter and installers", () => {
    const root = mkproject({ codex: true });
    expect(codexAdapter.install(root, { instructions: false }).ok).toBe(true);
    const matcher = fileMatcherOf(root, join(".codex", "hooks.json"));
    expect(matcher).toBeTruthy();
    expect(sh).toContain(matcher!);
    expect(ps1).toContain(matcher!);
  });

  it("commands contain check-prompt/check-file + correct --tool in both installers", () => {
    // install.sh: command is a literal in a python heredoc -> assert the full string
    for (const cmd of [
      "check-prompt --tool claude-code",
      "check-file --tool claude-code",
      "check-prompt --tool codex",
      "check-file --tool codex",
    ]) {
      expect(sh).toContain(cmd);
    }
    // install.ps1: command is built DYNAMICALLY (' check-prompt --tool ' + tool) -> assert the fragments
    // + the <tool> <matcher> pair passed to Register-AiGuardHooks (locks the tool↔matcher pairing)
    expect(ps1).toContain("' check-prompt --tool ' + tool");
    expect(ps1).toContain("' check-file --tool ' + tool");
    expect(ps1).toContain('"claude-code" "Read|Glob|Grep"');
    expect(ps1).toContain('"codex" "Edit|Write|apply_patch|mcp__.*"');
  });
});
