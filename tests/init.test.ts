import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { init } from "../src/commands/init";

describe("init", () => {
  it("creates .ai-guard structure + gitignore entries", async () => {
    const root = mkproject({ claudeCode: true, gitignore: true });
    const res = await init(["--root", root, "--tools", "claude-code"], "");
    expect(res).toBe(0);
    expect(existsSync(join(root, ".ai-guard", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".ai-guard", "rules.json"))).toBe(true);
    expect(existsSync(join(root, ".ai-guard", "logs"))).toBe(true);
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gi).toContain(".ai-guard/logs/");
    expect(gi).toContain(".ai-guard/.bypass/");
  });
  it("does not overwrite rules.json if the user already has one", async () => {
    const root = mkproject({});
    mkdirSync(join(root, ".ai-guard"), { recursive: true });
    writeFileSync(join(root, ".ai-guard", "rules.json"), '{"add":[{"id":"x","severity":"block","pattern":"X-[0-9]{4}","description":"x"}]}');
    const res = await init(["--root", root, "--tools", "claude-code"], "");
    expect(res).toBe(0);
    const rules = JSON.parse(readFileSync(join(root, ".ai-guard", "rules.json"), "utf8"));
    expect(rules.add[0].id).toBe("x");
  });
  it("installs hooks for detected tools when --tools is not passed", async () => {
    const root = mkproject({ claudeCode: true, codex: true });
    const res = await init(["--root", root], "");
    expect(res).toBe(0);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(root, ".codex", "hooks.json"))).toBe(true);
  });
  it("--no-instructions: does not create CLAUDE.md", async () => {
    const root = mkproject({ claudeCode: true });
    const res = await init(["--root", root, "--tools", "claude-code", "--no-instructions"], "");
    expect(res).toBe(0);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
  });
  it("no tool detected -> exit 1 + guidance", async () => {
    const root = mkproject({});
    const res = await init(["--root", root], "");
    expect(res).toBe(1);
  });
});
