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
  it("clean prompt -> exit 0, no log", async () => {
    expect(await runCli(["check-prompt", "--root", root], stdinOf(root, "giúp tôi viết hàm sort"))).toBe(0);
    expect(existsSync(join(root, ".ai-guard", "logs"))).toBe(false);
  });
  it("prompt with AWS key -> exit 2, stderr has bypass hint, log blocked", async () => {
    const code = await runCli(["check-prompt", "--root", root], stdinOf(root, "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi"));
    expect(code).toBe(2);
    expect(lastEvent().action).toBe("blocked");
    expect(lastEvent().rule).toBe("aws-access-key");
    expect(JSON.stringify(lastEvent())).not.toContain("IOSFODNN7EXAMPLE");
  });
  it("warn-only findings -> exit 0 + log warned", async () => {
    const code = await runCli(["check-prompt", "--root", root], stdinOf(root, "jwt đây: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"));
    expect(code).toBe(0);
    expect(lastEvent().action).toBe("warned");
  });
  it("valid prompt bypass -> exit 0 + log allowed_after_confirm", async () => {
    grantBypass(root, "prompt", undefined, 5);
    const code = await runCli(["check-prompt", "--root", root], stdinOf(root, "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi"));
    expect(code).toBe(0);
    expect(lastEvent().action).toBe("allowed_after_confirm");
  });
  it("root without .ai-guard -> exit 0 (fail-open)", async () => {
    const nowhere = mkdtempSync(join(tmpdir(), "aig-none-"));
    expect(await runCli(["check-prompt", "--root", nowhere], stdinOf(nowhere, "AKIAIOSFODNN7EXAMPLE"))).toBe(0);
  });
  it("stdin is not JSON -> treat all of it as the prompt (used by shims)", async () => {
    expect(await runCli(["check-prompt", "--root", root], " plaintext AKIAIOSFODNN7EXAMPLE ")).toBe(2);
  });
  it("valid JSON but no alias field -> scan raw (shim alias-miss fallback)", async () => {
    // cline UserPromptSubmit shim fallback: JSON payload with unknown field name -> pass raw stdin through unchanged
    const payload = JSON.stringify({ clineVersion: "3.36", question: "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi" });
    expect(await runCli(["check-prompt", "--root", root], payload)).toBe(2);
  });
  it("payload key userPrompt (kiro UserPromptSubmit) -> extract + block", async () => {
    // user-verified: Kiro hook payload prompt text is found under key userPrompt
    expect(await runCli(["check-prompt", "--root", root], JSON.stringify({ userPrompt: "AKIAIOSFODNN7EXAMPLE" }))).toBe(2);
  });
  it("payload key content (kiro UserPromptSubmit alias) -> extract + block", async () => {
    expect(await runCli(["check-prompt", "--root", root], JSON.stringify({ content: "x ghp_" + "a".repeat(36) }))).toBe(2);
  });
  it("nested data.prompt payload (kiro #10346 shape) -> extract + block", async () => {
    expect(
      await runCli(["check-prompt", "--root", root], JSON.stringify({ data: { prompt: "AKIAIOSFODNN7EXAMPLE" } })),
    ).toBe(2);
  });
  it("nested triggerData.prompt payload (kiro #10346 shape) -> extract + block", async () => {
    expect(
      await runCli(["check-prompt", "--root", root], JSON.stringify({ triggerData: { prompt: "AKIAIOSFODNN7EXAMPLE" } })),
    ).toBe(2);
  });
  it("--warn-only: block findings -> still exit 2 but action 'warned' + stderr states it cannot block", async () => {
    const errSpy = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as any).write = (s: string) => { captured += s; return true; };
    let code: number;
    try {
      code = await runCli(["check-prompt", "--root", root, "--warn-only"], stdinOf(root, "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi"));
    } finally {
      (process.stderr as any).write = errSpy;
    }
    expect(code).toBe(2);
    expect(lastEvent().action).toBe("warned");
    expect(lastEvent().rule).toBe("aws-access-key");
    expect(captured).toContain("aws-access-key");
    expect(captured).toContain("cannot block");
  });
  it("--warn-only + valid bypass -> exit 0 + allowed_after_confirm (no warn spam)", async () => {
    grantBypass(root, "prompt", undefined, 5);
    const code = await runCli(["check-prompt", "--root", root, "--warn-only"], stdinOf(root, "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi"));
    expect(code).toBe(0);
    expect(lastEvent().action).toBe("allowed_after_confirm");
  });
  it("warn + block -> 2 events in order (warned then blocked)", async () => {
    const code = await runCli(["check-prompt", "--root", root], stdinOf(root, "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U và AKIAIOSFODNN7EXAMPLE"));
    expect(code).toBe(2);
    const dir = join(root, ".ai-guard", "logs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).action).toBe("warned");
    expect(JSON.parse(lines[1]).action).toBe("blocked");
  });
  it("dangling --root does not crash, fail-open exit 0/2 is valid", async () => {
    // fallback is process.cwd(); chdir into tmp root (has .ai-guard) to pin exit 2 deterministically
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await runCli(["check-prompt", "--root"], stdinOf(root, "AKIAIOSFODNN7EXAMPLE"))).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });
});
