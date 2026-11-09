import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantBypass, hasValidBypass } from "../src/bypass/store";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aig-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
});

describe("bypass store", () => {
  it("not granted -> no bypass", () => {
    expect(hasValidBypass(root, "prompt")).toBe(false);
  });
  it("grant prompt for 5 minutes -> valid, metadata readable", () => {
    const meta = grantBypass(root, "prompt", undefined, 5);
    expect(meta.duration_min).toBe(5);
    expect(hasValidBypass(root, "prompt")).toBe(true);
  });
  it("expired -> invalid and file cleaned up", () => {
    grantBypass(root, "prompt", undefined, 0); // 0 minutes = expires immediately
    expect(hasValidBypass(root, "prompt")).toBe(false);
  });
  it("file bypass is scoped to the exact path", () => {
    grantBypass(root, "file", ".env", 10);
    expect(hasValidBypass(root, "file", ".env")).toBe(true);
    expect(hasValidBypass(root, "file", "other.key")).toBe(false);
  });
  it("prompt bypass does NOT unlock file bypass", () => {
    grantBypass(root, "prompt", undefined, 5);
    expect(hasValidBypass(root, "file", ".env")).toBe(false);
  });
  it("file flag does NOT unlock prompt bypass", () => {
    grantBypass(root, "file", ".env", 5);
    expect(hasValidBypass(root, "prompt")).toBe(false);
  });
  it("expired flag is DELETED from disk", () => {
    grantBypass(root, "prompt", undefined, 0);
    hasValidBypass(root, "prompt");
    const dir = join(root, ".ai-guard", ".bypass");
    const remaining = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(remaining.length).toBe(0);
  });
});
