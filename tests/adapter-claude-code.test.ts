import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { claudeCodeAdapter } from "../src/adapters/claude-code";

describe("claude-code adapter", () => {
  it("detect: có .claude -> true", () => {
    expect(claudeCodeAdapter.detect(mkproject({ claudeCode: true }))).toBe(true);
    expect(claudeCodeAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install: tạo hooks UserPromptSubmit + PreToolUse với command chứa marker", () => {
    const root = mkproject({ claudeCode: true });
    const res = claudeCodeAdapter.install(root, { instructions: false });
    expect(res.ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    const ups = settings.hooks.UserPromptSubmit;
    const ptu = settings.hooks.PreToolUse;
    expect(JSON.stringify(ups)).toContain("ai-guard check-prompt");
    expect(JSON.stringify(ptu)).toContain("ai-guard check-file");
    expect(JSON.stringify(ptu)).toContain("Read|Glob|Grep");
  });
  it("install 2 lần: không nhân đôi entry", () => {
    const root = mkproject({ claudeCode: true });
    claudeCodeAdapter.install(root, { instructions: false });
    claudeCodeAdapter.install(root, { instructions: false });
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    const cmds = JSON.stringify(settings.hooks.UserPromptSubmit).match(/ai-guard check-prompt/g) ?? [];
    expect(cmds.length).toBe(1);
  });
  it("install giữ nguyên config cũ của user", () => {
    const root = mkproject({ claudeCode: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    claudeCodeAdapter.install(root, { instructions: false });
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toContain("Bash(ls)");
    expect(settings.hooks).toBeTruthy();
  });
  it("install với instructions:true -> append section vào CLAUDE.md có marker", () => {
    const root = mkproject({ claudeCode: true });
    claudeCodeAdapter.install(root, { instructions: true });
    const md = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(md).toContain("ai-guard");
    expect(md).toContain("credential");
  });
  it("uninstall: gỡ hook ai-guard, giữ config khác + backup", () => {
    const root = mkproject({ claudeCode: true });
    claudeCodeAdapter.install(root, { instructions: false });
    const res = claudeCodeAdapter.uninstall(root);
    expect(res.ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(settings)).not.toContain("ai-guard");
  });
  it("doctor: sau install -> ok", () => {
    const root = mkproject({ claudeCode: true });
    claudeCodeAdapter.install(root, { instructions: false });
    expect(claudeCodeAdapter.doctor(root).ok).toBe(true);
  });
});
