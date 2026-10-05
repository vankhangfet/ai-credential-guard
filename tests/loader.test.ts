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
  it("add trùng id built-in -> THAY THẾ (không nhân đôi)", () => {
    const rules = loadRules(mkProject({ add: [{ id: "jwt", severity: "block", pattern: "REPLACED-[A-Z]+", description: "replaced" }] }));
    const jwt = rules.filter((r) => r.id === "jwt");
    expect(jwt.length).toBe(1);
    expect(jwt[0].severity).toBe("block");
  });
  it("remove + add cùng id -> rule mới giữ lại (replace được pattern built-in)", () => {
    const rules = loadRules(mkProject({ remove: ["jwt"], add: [{ id: "jwt", severity: "warn", pattern: "NEWJWT-[0-9]+", description: "new" }] }));
    const jwt = rules.filter((r) => r.id === "jwt");
    expect(jwt.length).toBe(1);
    expect(jwt[0].re!.test("NEWJWT-123")).toBe(true);
  });
  it("add severity sai -> bị bỏ qua, built-in nguyên vẹn", () => {
    const rules = loadRules(mkProject({ add: [{ id: "bad", severity: "blok", pattern: "X", description: "x" }] }));
    expect(rules.some((r) => r.id === "bad")).toBe(false);
  });
  it("override severity sai -> bỏ qua, giữ severity gốc", () => {
    const rules = loadRules(mkProject({ override: { jwt: { severity: "blok" } } }));
    expect(rules.find((r) => r.id === "jwt")!.severity).toBe("warn");
  });
  it("override id không tồn tại -> vô hiệu vô hại", () => {
    expect(() => loadRules(mkProject({ override: { nope: { severity: "block" } } }))).not.toThrow();
  });
  it("rules.json rỗng {} -> built-in nguyên vẹn", () => {
    const rules = loadRules(mkProject({}));
    expect(rules.some((r) => r.id === "aws-access-key")).toBe(true);
  });
  it("config.json hỏng -> default config, không throw", () => {
    const root = mkdtempSync(join(tmpdir(), "aig-"));
    mkdirSync(join(root, ".ai-guard"), { recursive: true });
    writeFileSync(join(root, ".ai-guard", "config.json"), "{bad");
    const cfg = loadConfig(root);
    expect(cfg.genericSecret).toBe(true);
    expect(Array.isArray(cfg.sensitivePaths)).toBe(true);
  });
});

describe("loadConfig", () => {
  it("default khi không có config", () => {
    const cfg = loadConfig(mkProject());
    expect(cfg.sensitivePaths).toBeTruthy();
    expect(cfg.genericSecret).toBe(true);
  });
});
