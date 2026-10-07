import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "../src/root";
import { appendAuditEvent } from "../src/audit/log";

let root: string;
let nested: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aig-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
  nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });
});

describe("findProjectRoot", () => {
  it("tìm .ai-guard từ thư mục con", () => {
    expect(findProjectRoot(nested)).toBe(root);
  });
  it("env AI_GUARD_ROOT thắng", () => {
    process.env.AI_GUARD_ROOT = root;
    try { expect(findProjectRoot(join(tmpdir()))).toBe(root); }
    finally { delete process.env.AI_GUARD_ROOT; }
  });
  it("not found -> null", () => {
    const nowhere = mkdtempSync(join(tmpdir(), "aig-none-"));
    expect(findProjectRoot(nowhere)).toBeNull();
  });
});

describe("appendAuditEvent", () => {
  it("ghi 1 dòng JSONL vào logs/YYYY-MM-DD.jsonl với ts ISO", () => {
    appendAuditEvent(root, { ts: new Date().toISOString(), tool: "claude-code", event: "prompt", action: "blocked", rule: "jwt" });
    const files = readdirSync(join(root, ".ai-guard", "logs"));
    expect(files.length).toBe(1);
    const line = readFileSync(join(root, ".ai-guard", "logs", files[0]), "utf8").trim();
    const evt = JSON.parse(line);
    expect(evt.tool).toBe("claude-code");
    expect(evt.action).toBe("blocked");
  });
  it("append nhiều event thành nhiều dòng", () => {
    appendAuditEvent(root, { ts: new Date().toISOString(), tool: "x", event: "prompt", action: "warned" });
    appendAuditEvent(root, { ts: new Date().toISOString(), tool: "x", event: "prompt", action: "blocked" });
    const files = readdirSync(join(root, ".ai-guard", "logs"));
    const lines = readFileSync(join(root, ".ai-guard", "logs", files[0]), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });
  it("không throw khi ghi log thất bại (root là file)", () => {
    const fileAsRoot = join(tmpdir(), "aig-file-root-" + Date.now());
    writeFileSync(fileAsRoot, "x");
    expect(() => appendAuditEvent(fileAsRoot, { ts: "", tool: "x", event: "prompt", action: "blocked" })).not.toThrow();
    expect(() => appendAuditEvent(fileAsRoot + "/nope", { ts: "", tool: "x", event: "prompt", action: "blocked" })).not.toThrow();
  });
});
