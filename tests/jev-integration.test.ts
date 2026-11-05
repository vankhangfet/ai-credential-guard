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
      genericSecret: false, // tắt engine để cô lập hành vi JEV
      highEntropy: false,
      jev: { enabled: true, endpoint: "http://localhost:8000/decide", apiKeyEnv: "JEV_API_KEY", mode, threshold, timeoutMs: 1000 },
    }),
  );
}

// stub global fetch trả về xác suất cho sẵn theo question id.
function stubFetch(scores: Record<string, number>) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ answers: Object.entries(scores).map(([id, probability]) => ({ id, probability })) }),
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

  it("JEV dưới threshold -> exit 0, không log", async () => {
    writeJevConfig("block", 0.9);
    stubFetch({ "jev-credential": 0.5 });
    expect(await runCli(["check-prompt", "--root", root], stdinOf("prompt"))).toBe(0);
  });

  it("JEV endpoint lỗi -> fail-open exit 0", async () => {
    writeJevConfig("block");
    globalThis.fetch = vi.fn(async () => { throw new Error("down"); }) as any;
    expect(await runCli(["check-prompt", "--root", root], stdinOf("prompt"))).toBe(0);
  });

  it("JEV disabled (mặc định) -> không gọi fetch", async () => {
    // không ghi config -> jev disabled; engine cũng tắt vì prompt sạch
    const spy = vi.fn();
    globalThis.fetch = spy as any;
    await runCli(["check-prompt", "--root", root], stdinOf("prompt sạch bình thường"));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("check-file + JEV (content scan)", () => {
  it("file thường chứa credential theo JEV -> exit 2", async () => {
    writeJevConfig("block");
    stubFetch({ "jev-credential": 0.95 });
    writeFileSync(join(root, "config.ts"), "export const key = 'something';\n");
    const code = await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, "config.ts")], "");
    expect(code).toBe(2);
    expect(lastEvent().action).toBe("blocked");
    expect(lastEvent().source).toBe("jev");
    expect(lastEvent().path).toBe("config.ts");
  });

  it("file thường sạch theo JEV -> exit 0", async () => {
    writeJevConfig("block");
    stubFetch({ "jev-credential": 0.1 });
    writeFileSync(join(root, "config.ts"), "export const key = 'ok';\n");
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, "config.ts")], "")).toBe(0);
  });

  it("file không tồn tại -> bỏ qua, exit 0", async () => {
    writeJevConfig("block");
    stubFetch({ "jev-credential": 0.99 });
    expect(await runCli(["check-file", "--root", root, "--tool", "claude-code", join(root, "nope.ts")], "")).toBe(0);
  });
});
