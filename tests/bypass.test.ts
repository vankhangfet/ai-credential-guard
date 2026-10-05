import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantBypass, hasValidBypass } from "../src/bypass/store";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aig-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
});

describe("bypass store", () => {
  it("chưa grant -> không có bypass", () => {
    expect(hasValidBypass(root, "prompt")).toBe(false);
  });
  it("grant prompt 5 phút -> valid, đọc được metadata", () => {
    const meta = grantBypass(root, "prompt", undefined, 5);
    expect(meta.duration_min).toBe(5);
    expect(hasValidBypass(root, "prompt")).toBe(true);
  });
  it("hết hạn -> invalid và file bị dọn", () => {
    grantBypass(root, "prompt", undefined, 0); // 0 phút = hết ngay
    expect(hasValidBypass(root, "prompt")).toBe(false);
  });
  it("bypass file scope theo đúng path", () => {
    grantBypass(root, "file", ".env", 10);
    expect(hasValidBypass(root, "file", ".env")).toBe(true);
    expect(hasValidBypass(root, "file", "other.key")).toBe(false);
  });
  it("prompt bypass KHÔNG mở file bypass", () => {
    grantBypass(root, "prompt", undefined, 5);
    expect(hasValidBypass(root, "file", ".env")).toBe(false);
  });
});
