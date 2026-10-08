import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { grantBypass } from "../src/bypass/store";

let root: string;
const stdinOf = (root: string, prompt: string) =>
  JSON.stringify({ tool: "claude-code", prompt, cwd: root, session: "s1" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aig-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
});

function lastEvent(): any {
  const dir = join(root, ".ai-guard", "logs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const lines = readFileSync(join(dir, files[files.length - 1]), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

describe("check-prompt", () => {
  it("prompt sạch -> exit 0, không log", async () => {
    expect(await runCli(["check-prompt", "--root", root], stdinOf(root, "giúp tôi viết hàm sort"))).toBe(0);
    expect(existsSync(join(root, ".ai-guard", "logs"))).toBe(false);
  });
  it("prompt chứa AWS key -> exit 2, stderr có hướng dẫn bypass, log blocked", async () => {
    const code = await runCli(["check-prompt", "--root", root], stdinOf(root, "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi"));
    expect(code).toBe(2);
    expect(lastEvent().action).toBe("blocked");
    expect(lastEvent().rule).toBe("aws-access-key");
    expect(JSON.stringify(lastEvent())).not.toContain("IOSFODNN7EXAMPLE");
  });
  it("chỉ finding warn -> exit 0 + log warned", async () => {
    const code = await runCli(["check-prompt", "--root", root], stdinOf(root, "jwt đây: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"));
    expect(code).toBe(0);
    expect(lastEvent().action).toBe("warned");
  });
  it("có bypass prompt hợp lệ -> exit 0 + log allowed_after_confirm", async () => {
    grantBypass(root, "prompt", undefined, 5);
    const code = await runCli(["check-prompt", "--root", root], stdinOf(root, "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi"));
    expect(code).toBe(0);
    expect(lastEvent().action).toBe("allowed_after_confirm");
  });
  it("root không có .ai-guard -> exit 0 (fail-open)", async () => {
    const nowhere = mkdtempSync(join(tmpdir(), "aig-none-"));
    expect(await runCli(["check-prompt", "--root", nowhere], stdinOf(nowhere, "AKIAIOSFODNN7EXAMPLE"))).toBe(0);
  });
  it("stdin không phải JSON -> coi toàn bộ là prompt (shim dùng)", async () => {
    expect(await runCli(["check-prompt", "--root", root], " plaintext AKIAIOSFODNN7EXAMPLE ")).toBe(2);
  });
  it("JSON hợp lệ nhưng không alias field nào -> quét raw (fallback alias-miss của shim)", async () => {
    // cline UserPromptSubmit shim fallback: payload JSON field name lạ -> truyền nguyên raw stdin
    const payload = JSON.stringify({ clineVersion: "3.36", question: "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi" });
    expect(await runCli(["check-prompt", "--root", root], payload)).toBe(2);
  });
  it("payload key userPrompt (kiro UserPromptSubmit) -> extract + block", async () => {
    // user-verified: Kiro hook payload prompt text findable dưới key userPrompt
    expect(await runCli(["check-prompt", "--root", root], JSON.stringify({ userPrompt: "AKIAIOSFODNN7EXAMPLE" }))).toBe(2);
  });
  it("payload key content (kiro UserPromptSubmit alias) -> extract + block", async () => {
    expect(await runCli(["check-prompt", "--root", root], JSON.stringify({ content: "x ghp_" + "a".repeat(36) }))).toBe(2);
  });
  it("warn + block -> 2 events đúng thứ tự (warned rồi blocked)", async () => {
    const code = await runCli(["check-prompt", "--root", root], stdinOf(root, "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U và AKIAIOSFODNN7EXAMPLE"));
    expect(code).toBe(2);
    const dir = join(root, ".ai-guard", "logs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).action).toBe("warned");
    expect(JSON.parse(lines[1]).action).toBe("blocked");
  });
  it("dangling --root không crash, fail-open exit 0/2 hợp lệ", async () => {
    // fallback là process.cwd(); chdir vào tmp root (có .ai-guard) để pin deterministically exit 2
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await runCli(["check-prompt", "--root"], stdinOf(root, "AKIAIOSFODNN7EXAMPLE"))).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });
});
