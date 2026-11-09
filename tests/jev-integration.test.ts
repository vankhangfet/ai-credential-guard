import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";

let root: string;
const origFetch = globalThis.fetch;

function writeJevConfig(mode: "warn" | "block" = "block", threshold = 0.8) {
  writeFileSync(
    join(root, ".ai-guard", "config.json"),
    JSON.stringify({
      sensitivePaths: null,
      genericSecret: false, // disable the engine to isolate JEV behavior
      highEntropy: false,
      jev: { enabled: true, endpoint: "http://localhost:8000/decide", apiKeyEnv: "JEV_API_KEY", mode, threshold, timeoutMs: 1000 },
    }),
  );
}

// Stub global fetch to return preset probabilities per question id.
function stubFetch(scores: Record<string, number>) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      answers: Object.fromEntries(Object.entries(scores).map(([id, noul]) => [id, { type: "noul", noul }])),
    }),
  })) as any;
}

function lastEvent(): any {
  const dir = join(root, ".ai-guard", "logs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const lines = readFileSync(join(dir, files[files.length - 1]), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aig-jev-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
});
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

const stdinOf = (prompt: string) => JSON.stringify({ tool: "claude-code", prompt, cwd: root });

describe("check-prompt + JEV", () => {
  it("JEV block finding -> exit 2, audit source=jev + score", async () => {
    writeJevConfig("block");
    stubFetch({ "jev-credential": 0.97 });
    const code = await runCli(["check-prompt", "--root", root], stdinOf("đây là một prompt bình thường"));
    expect(code).toBe(2);
    expect(lastEvent().action).toBe("blocked");
    expect(lastEvent().rule).toBe("jev-credential");
    expect(lastEvent().source).toBe("jev");
    expect(lastEvent().score).toBeCloseTo(0.97, 2);
  });

  it("JEV mode=warn -> exit 0 + log warned", async () => {
    writeJevConfig("warn");
    stubFetch({ "jev-unauthorized-access": 0.9 });
    const code = await runCli(["check-prompt", "--root", root], stdinOf("prompt"));
    expect(code).toBe(0);
    expect(lastEvent().action).toBe("warned");
    expect(lastEvent().source).toBe("jev");
  });

  it("JEV below threshold -> exit 0, no log", async () => {
    writeJevConfig("block", 0.9);
    stubFetch({ "jev-credential": 0.5 });
    expect(await runCli(["check-prompt", "--root", root], stdinOf("prompt"))).toBe(0);
  });

  it("JEV endpoint error -> fail-open exit 0", async () => {
    writeJevConfig("block");
    globalThis.fetch = vi.fn(async () => { throw new Error("down"); }) as any;
    expect(await runCli(["check-prompt", "--root", root], stdinOf("prompt"))).toBe(0);
  });

  it("JEV disabled (default) -> fetch not called", async () => {
    // no config written -> jev disabled; the engine is also off because the prompt is clean
    const spy = vi.fn();
    globalThis.fetch = spy as any;
    await runCli(["check-prompt", "--root", root], stdinOf("prompt sạch bình thường"));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("check-file + JEV (content scan)", () => {
  it("regular file with credential per JEV -> exit 2", async () => {
    writeJevConfig("block");
    stubFetch({ "jev-credential": 0.95 });
    writeFileSync(join(root, "config.ts"), "export const key = 'something';\n");
    const code = await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, "config.ts")], "");
    expect(code).toBe(2);
    expect(lastEvent().action).toBe("blocked");
    expect(lastEvent().source).toBe("jev");
    expect(lastEvent().path).toBe("config.ts");
  });

  it("regular file clean per JEV -> exit 0", async () => {
    writeJevConfig("block");
    stubFetch({ "jev-credential": 0.1 });
    writeFileSync(join(root, "config.ts"), "export const key = 'ok';\n");
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, "config.ts")], "")).toBe(0);
  });

  it("nonexistent file -> skipped, exit 0", async () => {
    writeJevConfig("block");
    stubFetch({ "jev-credential": 0.99 });
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, "nope.ts")], "")).toBe(0);
  });
});
