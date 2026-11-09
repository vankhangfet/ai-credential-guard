import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { doctor } from "../src/commands/doctor";
import { selfTest } from "../src/commands/self-test";
import { claudeCodeAdapter } from "../src/adapters/claude-code";

describe("self-test", () => {
  it("every fixture behaves as expected", () => {
    const res = selfTest();
    expect(res.failures).toEqual([]);
    expect(res.total).toBeGreaterThan(5);
  });
});

describe("doctor", () => {
  it("project with claude-code installed -> ok, exit 0", async () => {
    const root = mkproject({ claudeCode: true });
    claudeCodeAdapter.install(root, { instructions: false });
    const code = await doctor(["--root", root]);
    expect(code).toBe(0);
  });
  it("claude-code detected but hook missing -> exit 1 with details", async () => {
    const root = mkproject({ claudeCode: true });
    const code = await doctor(["--root", root]);
    expect(code).toBe(1);
  });
  it("no .ai-guard -> exit 1 + stderr hint", async () => {
    const nowhere = mkdtempSync(join(tmpdir(), "aig-none-"));
    expect(await doctor(["--root", nowhere])).toBe(1);
  });
});
