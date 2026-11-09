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
  it("regular file -> exit 0", async () => {
    writeFileSync(join(root, "readme.md"), "hi");
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, "readme.md")], "")).toBe(0);
  });
  it(".env -> exit 2 + stderr allow-file hint", async () => {
    const code = await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, ".env")], "");
    expect(code).toBe(2);
  });
  it(".env + bypass for exact path -> exit 0", async () => {
    grantBypass(root, "file", ".env", 10);
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, ".env")], "")).toBe(0);
  });
  it("bypass for a different path -> still exit 2", async () => {
    grantBypass(root, "file", "other.pem", 10);
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, ".env")], "")).toBe(2);
  });
  it("path as first argv (no flag) -> still blocked", async () => {
    // no --root: fallback is process.cwd(); chdir into tmp root (has .ai-guard) to pin exit 2 deterministically
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await runCli(["check-file", join(root, ".env")], "")).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });
  it("argv path wins over stdin payload (precedence)", async () => {
    writeFileSync(join(root, "readme.md"), "hi");
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, join(root, "readme.md")], payload)).toBe(0);
  });
  it("file outside root (../) is still blocked by basename", async () => {
    const outside = mkdtempSync(join(tmpdir(), "aig-out-"));
    writeFileSync(join(outside, "leak.pem"), "x");
    expect(await runCli(["check-file", "--root", root, join(outside, "leak.pem")], "")).toBe(2);
  });
  it("stderr contains path + allow hint", async () => {
    const errSpy = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as any).write = (s: string) => { captured += s; return true; };
    try {
      await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, ".env")], "");
    } finally {
      (process.stderr as any).write = errSpy;
    }
    expect(captured).toContain("ai-guard");
    expect(captured).toContain(".env");
    expect(captured).toContain("allow file");
  });
});

describe("check-file stdin payload (Claude Code PreToolUse)", () => {
  it("payload with tool_input.file_path = .env -> exit 2", async () => {
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(root, ".env") }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code"], payload)).toBe(2);
  });
  it("payload for another tool (Bash) without file_path -> exit 0", async () => {
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code"], payload)).toBe(0);
  });
  it("relative path is resolved against root", async () => {
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: ".env" }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code"], payload)).toBe(2);
  });
});

describe("check-file stdin payload (Codex apply_patch)", () => {
  it("apply_patch payload (Codex) -> extracts path from patch header", async () => {
    const payload = JSON.stringify({ tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: .env\n@@\n-a\n+b\n*** End Patch" } });
    expect(await runCli(["check-file", "--root", root, "--tool", "codex"], payload)).toBe(2);
  });
  it("multi-file patch: .env NOT last is still blocked (ordering bypass regression)", async () => {
    const payload = JSON.stringify({ tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: .env\n@@\n-a\n+b\n*** Update File: readme.md\n@@\n-x\n+y\n*** End Patch" } });
    expect(await runCli(["check-file", "--root", root, "--tool", "codex"], payload)).toBe(2);
  });
});

describe("check-file stdin payload (copilot CLI camelCase + kiro nested shapes)", () => {
  it("camelCase toolArgs payload (copilot CLI preToolUse, object form) with filePath .env -> exit 2", async () => {
    const payload = JSON.stringify({ toolName: "read", toolArgs: { filePath: join(root, ".env") }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(2);
  });
  it("toolArgs payload as JSON string -> parsed and blocks .env", async () => {
    const payload = JSON.stringify({ toolName: "read", toolArgs: JSON.stringify({ file_path: join(root, ".env") }), cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(2);
  });
  it("nested data.file_path payload (kiro shape) -> exit 2", async () => {
    const payload = JSON.stringify({ data: { file_path: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, "--tool", "kiro"], payload)).toBe(2);
  });
  it("nested triggerData.filePath payload -> exit 2", async () => {
    const payload = JSON.stringify({ triggerData: { filePath: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, "--tool", "kiro"], payload)).toBe(2);
  });
  it("toolArgs that is not an object/JSON string (number) -> ignored, exit 0", async () => {
    const payload = JSON.stringify({ toolName: "bash", toolArgs: 42 });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(0);
  });
  it("precedence between containers: tool_input (non-sensitive) wins over toolArgs (.env)", async () => {
    writeFileSync(join(root, "readme.md"), "hi");
    const payload = JSON.stringify({ tool_input: { path: join(root, "readme.md") }, toolArgs: { filePath: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(0);
  });
  it("toolArgs is a string that does not parse as JSON -> ignored, exit 0", async () => {
    const payload = JSON.stringify({ toolName: "read", toolArgs: "not json" });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(0);
  });
});
