import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { clineAdapter } from "../src/adapters/cline";

// Step 0 (verified): Cline hooks KHÔNG dùng settings.json kiểu Claude Code — mỗi event là
// MỘT script thực thi tại .clinerules/hooks/<EventType> (không extension) — blog v3.36
// "cline-v3-36-hooks" + dev.to + maybedont.ai. Prompt-side CÓ UserPromptSubmit (đăng ký luôn).
const HOOKS_DIR = join(".clinerules", "hooks");
const PRE = join(HOOKS_DIR, "PreToolUse");
const PROMPT = join(HOOKS_DIR, "UserPromptSubmit");

describe("cline adapter", () => {
  it("detect .cline/.clinerules dir", () => {
    expect(clineAdapter.detect(mkproject({ cline: true }))).toBe(true);
    expect(clineAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install ghi 2 hook script (PreToolUse + UserPromptSubmit) + idempotent", () => {
    const root = mkproject({ cline: true });
    expect(clineAdapter.install(root, { instructions: false }).ok).toBe(true);
    clineAdapter.install(root, { instructions: false });
    const pre = readFileSync(join(root, PRE), "utf8");
    expect(pre).toContain("ai-guard check-file");
    expect((pre.match(/ai-guard check-file/g) ?? []).length).toBe(1);
    expect(pre).toContain("cancel"); // blocking contract của Cline: stdout JSON {"cancel":true,...}
    const prompt = readFileSync(join(root, PROMPT), "utf8");
    expect(prompt).toContain("ai-guard check-prompt");
    expect((prompt.match(/ai-guard check-prompt/g) ?? []).length).toBe(1);
  });
  it("install giữ hook user ở event khác; không ghi đè hook lạ cùng slot", () => {
    const root = mkproject({ cline: true });
    // hook của user ở event khác (PostToolUse) — install không được đụng tới
    mkdirSync(join(root, HOOKS_DIR), { recursive: true });
    writeFileSync(join(root, HOOKS_DIR, "PostToolUse"), "#!/bin/sh\nexit 0\n");
    expect(clineAdapter.install(root, { instructions: false }).ok).toBe(true);
    expect(readFileSync(join(root, HOOKS_DIR, "PostToolUse"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    // hook lạ (không marker) chiếm đúng slot PreToolUse -> từ chối ghi đè, giữ nguyên file
    const root2 = mkproject({ cline: true });
    mkdirSync(join(root2, HOOKS_DIR), { recursive: true });
    writeFileSync(join(root2, PRE), "#!/bin/sh\n# my own hook\nexit 0\n");
    const res = clineAdapter.install(root2, { instructions: false });
    expect(res.ok).toBe(false);
    expect(readFileSync(join(root2, PRE), "utf8")).not.toContain("ai-guard");
    expect(existsSync(join(root2, PROMPT))).toBe(false); // atomic: không ghi nốt hook còn lại
  });
  it("uninstall gỡ hook của mình, giữ hook lạ/event khác", () => {
    const root = mkproject({ cline: true });
    clineAdapter.install(root, { instructions: false });
    writeFileSync(join(root, HOOKS_DIR, "PostToolUse"), "#!/bin/sh\nexit 0\n");
    expect(clineAdapter.uninstall(root).ok).toBe(true);
    expect(existsSync(join(root, PRE))).toBe(false);
    expect(existsSync(join(root, PROMPT))).toBe(false);
    expect(readFileSync(join(root, HOOKS_DIR, "PostToolUse"), "utf8")).toContain("exit 0");
  });
  it("doctor trước/sau install", () => {
    const root = mkproject({ cline: true });
    expect(clineAdapter.doctor(root).ok).toBe(false);
    clineAdapter.install(root, { instructions: false });
    expect(clineAdapter.doctor(root).ok).toBe(true);
  });
});
