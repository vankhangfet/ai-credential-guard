import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, loadConfig } from "../src/engine/loader";

function mkProject(rulesJson?: unknown, configJson?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "aig-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
  if (rulesJson) writeFileSync(join(root, ".ai-guard", "rules.json"), JSON.stringify(rulesJson));
  if (configJson) writeFileSync(join(root, ".ai-guard", "config.json"), JSON.stringify(configJson));
  return root;
}

describe("loadRules", () => {
  it("không có rules.json -> trả built-in nguyên vẹn", () => {
    const rules = loadRules(mkProject());
    expect(rules.some((r) => r.id === "aws-access-key")).toBe(true);
  });
  it("add rule mới của project", () => {
    const rules = loadRules(mkProject({ add: [{ id: "corp", severity: "block", pattern: "CORP-[A-Z0-9]{8}", description: "corp" }] }));
    expect(rules.some((r) => r.id === "corp" && r.re)).toBe(true);
  });
  it("override severity", () => {
    const rules = loadRules(mkProject({ override: { jwt: { severity: "block" } } }));
    expect(rules.find((r) => r.id === "jwt")!.severity).toBe("block");
  });
  it("remove rule", () => {
    const rules = loadRules(mkProject({ remove: ["jwt"] }));
    expect(rules.some((r) => r.id === "jwt")).toBe(false);
  });
  it("thứ tự: remove thắng override, add vẫn giữ", () => {
    const rules = loadRules(mkProject({ override: { jwt: { severity: "block" } }, remove: ["jwt"] }));
    expect(rules.some((r) => r.id === "jwt")).toBe(false);
  });
  it("rules.json hỏng (JSON sai cú pháp) -> built-in, không throw", () => {
    const root = mkdtempSync(join(tmpdir(), "aig-"));
    mkdirSync(join(root, ".ai-guard"), { recursive: true });
    writeFileSync(join(root, ".ai-guard", "rules.json"), "{invalid json");
    expect(() => loadRules(root)).not.toThrow();
    expect(loadRules(root).length).toBeGreaterThan(0);
  });
});

describe("loadConfig", () => {
  it("default khi không có config", () => {
    const cfg = loadConfig(mkProject());
    expect(cfg.sensitivePaths).toBeTruthy();
    expect(cfg.genericSecret).toBe(true);
  });
});
