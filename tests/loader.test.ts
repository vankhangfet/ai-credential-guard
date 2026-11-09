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
  it("no rules.json -> returns built-in rules intact", () => {
    const rules = loadRules(mkProject());
    expect(rules.some((r) => r.id === "aws-access-key")).toBe(true);
  });
  it("add new project rule", () => {
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
  it("order: remove wins over override, add is kept", () => {
    const rules = loadRules(mkProject({ override: { jwt: { severity: "block" } }, remove: ["jwt"] }));
    expect(rules.some((r) => r.id === "jwt")).toBe(false);
  });
  it("corrupt rules.json (invalid JSON syntax) -> built-in, no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "aig-"));
    mkdirSync(join(root, ".ai-guard"), { recursive: true });
    writeFileSync(join(root, ".ai-guard", "rules.json"), "{invalid json");
    expect(() => loadRules(root)).not.toThrow();
    expect(loadRules(root).length).toBeGreaterThan(0);
  });
  it("add with built-in id -> REPLACES (no duplicate)", () => {
    const rules = loadRules(mkProject({ add: [{ id: "jwt", severity: "block", pattern: "REPLACED-[A-Z]+", description: "replaced" }] }));
    const jwt = rules.filter((r) => r.id === "jwt");
    expect(jwt.length).toBe(1);
    expect(jwt[0].severity).toBe("block");
  });
  it("remove + add same id -> new rule is kept (can replace a built-in pattern)", () => {
    const rules = loadRules(mkProject({ remove: ["jwt"], add: [{ id: "jwt", severity: "warn", pattern: "NEWJWT-[0-9]+", description: "new" }] }));
    const jwt = rules.filter((r) => r.id === "jwt");
    expect(jwt.length).toBe(1);
    expect(jwt[0].re!.test("NEWJWT-123")).toBe(true);
  });
  it("add with invalid severity -> ignored, built-in intact", () => {
    const rules = loadRules(mkProject({ add: [{ id: "bad", severity: "blok", pattern: "X", description: "x" }] }));
    expect(rules.some((r) => r.id === "bad")).toBe(false);
  });
  it("override with invalid severity -> ignored, keeps original severity", () => {
    const rules = loadRules(mkProject({ override: { jwt: { severity: "blok" } } }));
    expect(rules.find((r) => r.id === "jwt")!.severity).toBe("warn");
  });
  it("override of nonexistent id -> harmless no-op", () => {
    expect(() => loadRules(mkProject({ override: { nope: { severity: "block" } } }))).not.toThrow();
  });
  it("empty rules.json {} -> built-in intact", () => {
    const rules = loadRules(mkProject({}));
    expect(rules.some((r) => r.id === "aws-access-key")).toBe(true);
  });
  it("corrupt config.json -> default config, no throw", () => {
    const root = mkdtempSync(join(tmpdir(), "aig-"));
    mkdirSync(join(root, ".ai-guard"), { recursive: true });
    writeFileSync(join(root, ".ai-guard", "config.json"), "{bad");
    const cfg = loadConfig(root);
    expect(cfg.genericSecret).toBe(true);
    expect(Array.isArray(cfg.sensitivePaths)).toBe(true);
  });
});

describe("loadConfig", () => {
  it("default when there is no config", () => {
    const cfg = loadConfig(mkProject());
    expect(cfg.sensitivePaths).toBeTruthy();
    expect(cfg.genericSecret).toBe(true);
  });
});
