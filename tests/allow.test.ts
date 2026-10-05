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
  it("allow file <path> --10m -> bypass đúng path", async () => {
    expect(await runCli(["allow", "file", ".env", "--10m", "--root", root], "")).toBe(0);
    expect(hasValidBypass(root, "file", ".env")).toBe(true);
    expect(hasValidBypass(root, "file", "khac.key")).toBe(false);
  });
  it("scope sai -> exit 1 + hướng dẫn", async () => {
    expect(await runCli(["allow", "wrong", "--5m", "--root", root], "")).toBe(1);
  });
  it("thiếu --Nm -> exit 1", async () => {
    expect(await runCli(["allow", "prompt", "--root", root], "")).toBe(1);
  });
  it("--0m và --2000m bị từ chối", async () => {
    expect(await runCli(["allow", "prompt", "--0m", "--root", root], "")).toBe(1);
    expect(await runCli(["allow", "prompt", "--2000m", "--root", root], "")).toBe(1);
  });
});
