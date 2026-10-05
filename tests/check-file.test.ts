import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { grantBypass } from "../src/bypass/store";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aig-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
  writeFileSync(join(root, ".env"), "DB_PASSWORD=secret123\n");
});

describe("check-file argv path", () => {
  it("file thường -> exit 0", async () => {
    writeFileSync(join(root, "readme.md"), "hi");
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, "readme.md")], "")).toBe(0);
  });
  it(".env -> exit 2 + stderr hướng dẫn allow file", async () => {
    const code = await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, ".env")], "");
    expect(code).toBe(2);
  });
  it(".env + bypass đúng path -> exit 0", async () => {
    grantBypass(root, "file", ".env", 10);
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, ".env")], "")).toBe(0);
  });
  it("bypass path khác -> vẫn exit 2", async () => {
    grantBypass(root, "file", "other.pem", 10);
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, ".env")], "")).toBe(2);
  });
});

describe("check-file stdin payload (Claude Code PreToolUse)", () => {
  it("payload có tool_input.file_path = .env -> exit 2", async () => {
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(root, ".env") }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code"], payload)).toBe(2);
  });
  it("payload tool khác (Bash) không có file_path -> exit 0", async () => {
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code"], payload)).toBe(0);
  });
  it("path tương đối giải quyết theo root", async () => {
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: ".env" }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code"], payload)).toBe(2);
  });
});
