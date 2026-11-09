import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { claudeCodeAdapter } from "../src/adapters/claude-code";

describe("claude-code adapter", () => {
  it("detect: .claude present -> true", () => {
    expect(claudeCodeAdapter.detect(mkproject({ claudeCode: true }))).toBe(true);
    expect(claudeCodeAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install: creates UserPromptSubmit + PreToolUse hooks with marker-bearing commands", () => {
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
  it("install twice: does not duplicate entries", () => {
    const root = mkproject({ claudeCode: true });
    claudeCodeAdapter.install(root, { instructions: false });
    claudeCodeAdapter.install(root, { instructions: false });
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    const cmds = JSON.stringify(settings.hooks.UserPromptSubmit).match(/ai-guard check-prompt/g) ?? [];
    expect(cmds.length).toBe(1);
  });
  it("install preserves the user's existing config", () => {
    const root = mkproject({ claudeCode: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    claudeCodeAdapter.install(root, { instructions: false });
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toContain("Bash(ls)");
    expect(settings.hooks).toBeTruthy();
  });
  it("install with instructions:true -> appends marked section to CLAUDE.md", () => {
    const root = mkproject({ claudeCode: true });
    claudeCodeAdapter.install(root, { instructions: true });
    const md = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(md).toContain("ai-guard");
    expect(md).toContain("credential");
  });
  it("uninstall: removes ai-guard hooks, keeps other config + backup", () => {
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
  it("user's own hook survives install + uninstall", () => {
    const root = mkproject({ claudeCode: true });
    const fs = require("node:fs");
    fs.mkdirSync(join(root, ".claude"), { recursive: true });
    fs.writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node mine.js" }] }] } }));
    claudeCodeAdapter.install(root, { instructions: false });
    claudeCodeAdapter.uninstall(root);
    const settings = JSON.parse(fs.readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain("node mine.js");
    expect(JSON.stringify(settings)).not.toContain("ai-guard");
  });
  it("malformed entry (missing hooks array) does not make doctor throw", () => {
    const root = mkproject({ claudeCode: true });
    const fs = require("node:fs");
    fs.mkdirSync(join(root, ".claude"), { recursive: true });
    fs.writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: "x" }] } }));
    expect(() => claudeCodeAdapter.doctor(root)).not.toThrow();
    expect(claudeCodeAdapter.doctor(root).ok).toBe(false);
  });
  it("uninstall without settings.json -> does not create a file", () => {
    const root = mkproject({ claudeCode: true });
    claudeCodeAdapter.uninstall(root);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
  });
});
