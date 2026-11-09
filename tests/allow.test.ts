import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { hasValidBypass } from "../src/bypass/store";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aig-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
});

describe("allow", () => {
  it("allow prompt --5m -> bypass prompt active, audit bypass_granted", async () => {
    expect(await runCli(["allow", "prompt", "--5m", "--root", root], "")).toBe(0);
    expect(hasValidBypass(root, "prompt")).toBe(true);
  });
  it("allow file <path> --10m -> bypass for the exact path", async () => {
    expect(await runCli(["allow", "file", ".env", "--10m", "--root", root], "")).toBe(0);
    expect(hasValidBypass(root, "file", ".env")).toBe(true);
    expect(hasValidBypass(root, "file", "khac.key")).toBe(false);
  });
  it("invalid scope -> exit 1 + usage hint", async () => {
    expect(await runCli(["allow", "wrong", "--5m", "--root", root], "")).toBe(1);
  });
  it("missing --Nm -> exit 1", async () => {
    expect(await runCli(["allow", "prompt", "--root", root], "")).toBe(1);
  });
  it("--0m and --2000m are rejected", async () => {
    expect(await runCli(["allow", "prompt", "--0m", "--root", root], "")).toBe(1);
    expect(await runCli(["allow", "prompt", "--2000m", "--root", root], "")).toBe(1);
  });
});
