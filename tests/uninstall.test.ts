import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { uninstall } from "../src/commands/uninstall";
import { init } from "../src/commands/init";

describe("uninstall", () => {
  it("gỡ hook ai-guard khỏi mọi adapter, giữ .ai-guard", async () => {
    const root = mkproject({ claudeCode: true });
    await init(["--root", root, "--tools", "claude-code"], "");
    const code = await uninstall(["--root", root]);
    expect(code).toBe(0);
    expect(existsSync(join(root, ".ai-guard"))).toBe(true);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
    const settings = JSON.parse(require("node:fs").readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(settings)).not.toContain("ai-guard");
  });
  it("--purge: xóa hẳn .ai-guard", async () => {
    const root = mkproject({ claudeCode: true });
    await init(["--root", root, "--tools", "claude-code"], "");
    expect(await uninstall(["--root", root, "--purge"])).toBe(0);
    expect(existsSync(join(root, ".ai-guard"))).toBe(false);
  });
});
