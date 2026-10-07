// Drift cross-check (Task 26): adapter TS ↔ fallback installers (install.sh / install.ps1).
// Lưu ý: đây là drift-check thuần, KHÔNG phải TDD — installers đã sync nên pass ngay;
// giá trị là khóa regression: đổi matcher/command ở một nguồn mà quên nguồn kia -> đỏ ở đây.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeAdapter } from "../src/adapters/claude-code";
import { codexAdapter } from "../src/adapters/codex";
import { mkproject } from "./util/mkproject";

const sh = readFileSync(join(__dirname, "..", "fallback", "install.sh"), "utf8");
const ps1 = readFileSync(join(__dirname, "..", "fallback", "install.ps1"), "utf8");

// Đọc matcher PreToolUse THỰC TẾ mà adapter ghi vào config (không hardcode lại ở test —
// nếu adapter đổi matcher, đây là nguồn duy nhất được so với installers).
function fileMatcherOf(root: string, rel: string): string | undefined {
  const cfg = JSON.parse(readFileSync(join(root, rel), "utf8"));
  const entry = (cfg.hooks?.PreToolUse ?? []).find((e: unknown) =>
    JSON.stringify(e).includes("check-file"),
  );
  return entry?.matcher;
}

describe("installer parity (drift cross-check)", () => {
  it("matcher claude-code đồng bộ giữa adapter TS và installers", () => {
    const root = mkproject({ claudeCode: true });
    expect(claudeCodeAdapter.install(root, { instructions: false }).ok).toBe(true);
    const matcher = fileMatcherOf(root, join(".claude", "settings.json"));
    expect(matcher).toBeTruthy();
    expect(sh).toContain(matcher!);
    expect(ps1).toContain(matcher!);
  });

  it("matcher codex đồng bộ giữa adapter TS và installers", () => {
    const root = mkproject({ codex: true });
    expect(codexAdapter.install(root, { instructions: false }).ok).toBe(true);
    const matcher = fileMatcherOf(root, join(".codex", "hooks.json"));
    expect(matcher).toBeTruthy();
    expect(sh).toContain(matcher!);
    expect(ps1).toContain(matcher!);
  });

  it("commands chứa check-prompt/check-file + --tool đúng trong cả 2 installer", () => {
    // install.sh: command ghép literal trong heredoc python -> assert chuỗi đầy đủ
    for (const cmd of [
      "check-prompt --tool claude-code",
      "check-file --tool claude-code",
      "check-prompt --tool codex",
      "check-file --tool codex",
    ]) {
      expect(sh).toContain(cmd);
    }
    // install.ps1: command ghép ĐỘNG (' check-prompt --tool ' + tool) -> assert mảnh ghép
    // + cặp <tool> <matcher> truyền vào Register-AiGuardHooks (khóa tool↔matcher đúng cặp)
    expect(ps1).toContain("' check-prompt --tool ' + tool");
    expect(ps1).toContain("' check-file --tool ' + tool");
    expect(ps1).toContain('"claude-code" "Read|Glob|Grep"');
    expect(ps1).toContain('"codex" "Edit|Write|apply_patch|mcp__.*"');
  });
});
