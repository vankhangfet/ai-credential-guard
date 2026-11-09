import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { codexAdapter } from "../src/adapters/codex";

describe("codex adapter", () => {
  it("detect .codex dir", () => {
    expect(codexAdapter.detect(mkproject({ codex: true }))).toBe(true);
    expect(codexAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install writes .codex/hooks.json with 2 events + marker, idempotent", () => {
    const root = mkproject({ codex: true });
    expect(codexAdapter.install(root, { instructions: false }).ok).toBe(true);
    codexAdapter.install(root, { instructions: false });
    const raw = readFileSync(join(root, ".codex", "hooks.json"), "utf8");
    expect(raw).toContain("UserPromptSubmit");
    expect(raw).toContain("PreToolUse");
    expect(raw).toContain("apply_patch");
    expect((raw.match(/ai-guard check-prompt/g) ?? []).length).toBe(1);
  });
  it("install creates AGENTS.md education section when instructions enabled (idempotent)", () => {
    const root = mkproject({ codex: true });
    codexAdapter.install(root, { instructions: true });
    codexAdapter.install(root, { instructions: true });
    const md = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(md).toContain("ai-guard:start");
    expect((md.match(/ai-guard:start/g) ?? []).length).toBe(1);
  });
  it("install preserves existing user config", () => {
    const root = mkproject({ codex: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }));
    codexAdapter.install(root, { instructions: false });
    const data = JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8"));
    expect(JSON.stringify(data.hooks.Stop)).toContain("echo done");
    expect(data.hooks.UserPromptSubmit).toBeTruthy();
  });
  it("uninstall removes marker entries, keeps the user's Stop", () => {
    const root = mkproject({ codex: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }));
    codexAdapter.install(root, { instructions: false });
    const res = codexAdapter.uninstall(root);
    expect(res.ok).toBe(true);
    const after = JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8"));
    expect(JSON.stringify(after.hooks.Stop)).toContain("echo done");
    expect(readFileSync(join(root, ".codex", "hooks.json"), "utf8")).not.toContain("ai-guard");
  });
  it("doctor: ok after install, fail before install", () => {
    const root = mkproject({ codex: true });
    expect(codexAdapter.doctor(root).ok).toBe(false);
    codexAdapter.install(root, { instructions: false });
    expect(codexAdapter.doctor(root).ok).toBe(true);
  });
  it("malformed entry (missing hooks array) does not make doctor throw", () => {
    const root = mkproject({ codex: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: "x" }] } }));
    expect(() => codexAdapter.doctor(root)).not.toThrow();
    expect(codexAdapter.doctor(root).ok).toBe(false);
  });
});
