import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Fix C (ride-along từ review Task 21): vitest THỰC THI template qua node thật để lock cancel
// contract giữa template và engine. Template fast-path spawn `node_modules/ai-guard/dist/cli.js`
// nên test copy dist ĐÃ BUILD của repo vào tmp project — CẦN `npm run build` trước; dist thiếu
// (CI chưa build) -> skip toàn bộ (it.skipIf).
const DIST_CLI = join(__dirname, "..", "dist", "cli.js");
const DIST_DIR = join(__dirname, "..", "dist");

describe("cline templates (thực thi qua node — lock cancel contract)", () => {
  function mkExecProject(): string {
    const root = mkproject({ cline: true }); // .ai-guard sẵn -> engine chặn được
    clineAdapter.install(root, { instructions: false });
    cpSync(DIST_DIR, join(root, "node_modules", "ai-guard", "dist"), { recursive: true });
    return root;
  }
  it.skipIf(!existsSync(DIST_CLI))("PreToolUse payload .env -> stdout {\"cancel\":true}", () => {
    const root = mkExecProject();
    const payload = JSON.stringify({
      tool_name: "read_file",
      tool_input: { path: join(root, ".env") },
      workspaceRoots: [root],
    });
    const r = spawnSync(process.execPath, [join(root, PRE)], { input: payload, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0); // contract Cline: chặn qua stdout JSON, KHÔNG qua exit code
    expect(r.stdout).toContain('"cancel":true');
    expect(r.stdout).toContain("errorMessage");
  });
  it.skipIf(!existsSync(DIST_CLI))("PreToolUse payload sạch -> stdout rỗng, exit 0", () => {
    const root = mkExecProject();
    const payload = JSON.stringify({
      tool_name: "read_file",
      tool_input: { path: join(root, "src", "main.ts") },
      workspaceRoots: [root],
    });
    const r = spawnSync(process.execPath, [join(root, PRE)], { input: payload, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
  it.skipIf(!existsSync(DIST_CLI))("UserPromptSubmit alias-miss (Fix B): secret trong RAW JSON vẫn bị chặn", () => {
    const root = mkExecProject();
    // payload JSON hợp lệ nhưng KHÔNG alias field nào match (question) — secret nằm nguyên văn
    // trong raw JSON -> template phải fallback quét raw thay vì bỏ qua.
    const payload = JSON.stringify({
      clineVersion: "3.36",
      question: "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi",
      workspaceRoots: [root],
    });
    const r = spawnSync(process.execPath, [join(root, PROMPT)], { input: payload, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"cancel":true');
  });
});
