import { describe, it, expect } from "vitest";
import { runCli } from "../src/cli";

describe("cli smoke", () => {
  it("version in ra stdout, exit 0", async () => {
    const code = await runCli(["version"], "");
    expect(code).toBe(0);
  });
  it("lệnh lạ exit 1", async () => {
    expect(await runCli(["nope"], "")).toBe(1);
  });
});
