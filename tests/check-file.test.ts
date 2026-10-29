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
  it("path là argv đầu tiên (không flag) -> vẫn chặn", async () => {
    // không có --root: fallback là process.cwd(); chdir vào tmp root (có .ai-guard) để pin deterministically exit 2
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await runCli(["check-file", join(root, ".env")], "")).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });
  it("argv path thắng stdin payload (precedence)", async () => {
    writeFileSync(join(root, "readme.md"), "hi");
    const payload = JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, join(root, "readme.md")], payload)).toBe(0);
  });
  it("file ngoài root (../) vẫn chặn theo basename", async () => {
    const outside = mkdtempSync(join(tmpdir(), "aig-out-"));
    writeFileSync(join(outside, "leak.pem"), "x");
    expect(await runCli(["check-file", "--root", root, join(outside, "leak.pem")], "")).toBe(2);
  });
  it("stderr chứa path + hướng dẫn allow", async () => {
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

describe("check-file stdin payload (Codex apply_patch)", () => {
  it("apply_patch payload (Codex) -> trích path từ patch header", async () => {
    const payload = JSON.stringify({ tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: .env\n@@\n-a\n+b\n*** End Patch" } });
    expect(await runCli(["check-file", "--root", root, "--tool", "codex"], payload)).toBe(2);
  });
  it("patch nhiều file: .env KHÔNG ở cuối vẫn chặn (ordering bypass regression)", async () => {
    const payload = JSON.stringify({ tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: .env\n@@\n-a\n+b\n*** Update File: readme.md\n@@\n-x\n+y\n*** End Patch" } });
    expect(await runCli(["check-file", "--root", root, "--tool", "codex"], payload)).toBe(2);
  });
});

describe("check-file stdin payload (copilot CLI camelCase + kiro nested shapes)", () => {
  it("payload camelCase toolArgs (copilot CLI preToolUse, object form) có filePath .env -> exit 2", async () => {
    const payload = JSON.stringify({ toolName: "read", toolArgs: { filePath: join(root, ".env") }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(2);
  });
  it("payload toolArgs dạng JSON string -> parse được và chặn .env", async () => {
    const payload = JSON.stringify({ toolName: "read", toolArgs: JSON.stringify({ file_path: join(root, ".env") }), cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(2);
  });
  it("payload lồng data.file_path (kiro shape) -> exit 2", async () => {
    const payload = JSON.stringify({ data: { file_path: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, "--tool", "kiro"], payload)).toBe(2);
  });
  it("payload lồng triggerData.filePath -> exit 2", async () => {
    const payload = JSON.stringify({ triggerData: { filePath: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, "--tool", "kiro"], payload)).toBe(2);
  });
  it("toolArgs không phải object/string JSON (số) -> bỏ qua, exit 0", async () => {
    const payload = JSON.stringify({ toolName: "bash", toolArgs: 42 });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(0);
  });
  it("precedence giữa containers: tool_input (non-sensitive) thắng toolArgs (.env)", async () => {
    writeFileSync(join(root, "readme.md"), "hi");
    const payload = JSON.stringify({ tool_input: { path: join(root, "readme.md") }, toolArgs: { filePath: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(0);
  });
  it("toolArgs là string không parse được JSON -> bỏ qua, exit 0", async () => {
    const payload = JSON.stringify({ toolName: "read", toolArgs: "not json" });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(0);
  });
});
