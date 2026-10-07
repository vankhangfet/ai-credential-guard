import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { opencodeAdapter } from "../src/adapters/opencode";

describe("opencode adapter", () => {
  it("detect .opencode dir", () => {
    expect(opencodeAdapter.detect(mkproject({ opencode: true }))).toBe(true);
    expect(opencodeAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install tạo shim plugin chứa marker + spawn check-file/check-prompt, idempotent", () => {
    const root = mkproject({ opencode: true });
    expect(opencodeAdapter.install(root, { instructions: false }).ok).toBe(true);
    opencodeAdapter.install(root, { instructions: false });
    const shim = readFileSync(join(root, ".opencode", "plugins", "ai-guard.ts"), "utf8");
    expect(shim).toContain("ai-guard check-file");
    expect(shim).toContain("ai-guard check-prompt");
  });
  it("install với instructions -> AGENTS.md có marker section", () => {
    const root = mkproject({ opencode: true });
    opencodeAdapter.install(root, { instructions: true });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("ai-guard:start");
  });
  it("uninstall xóa shim file, giữ AGENTS.md khác", () => {
    const root = mkproject({ opencode: true });
    opencodeAdapter.install(root, { instructions: true });
    const res = opencodeAdapter.uninstall(root);
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, ".opencode", "plugins", "ai-guard.ts"))).toBe(false);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
  });
  it("doctor: shim tồn tại -> ok", () => {
    const root = mkproject({ opencode: true });
    expect(opencodeAdapter.doctor(root).ok).toBe(false);
    opencodeAdapter.install(root, { instructions: false });
    expect(opencodeAdapter.doctor(root).ok).toBe(true);
  });
  it("doctor: shim file lạ (không marker) -> ok false", () => {
    const root = mkproject({ opencode: true });
    require("node:fs").mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    require("node:fs").writeFileSync(join(root, ".opencode", "plugins", "ai-guard.ts"), "export const X = async () => ({});\n");
    const d = opencodeAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("does not belong to ai-guard");
  });
  it("uninstall: shim file lạ (không marker) -> không xóa", () => {
    const root = mkproject({ opencode: true });
    require("node:fs").mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    require("node:fs").writeFileSync(join(root, ".opencode", "plugins", "ai-guard.ts"), "export const X = async () => ({});\n");
    const res = opencodeAdapter.uninstall(root);
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, ".opencode", "plugins", "ai-guard.ts"))).toBe(true);
  });
});
