import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { kiroAdapter } from "../src/adapters/kiro";
import { copilotAdapter } from "../src/adapters/copilot";

// Step 0 (verified):
//  - Kiro (kiro.dev/docs/hooks): hooks = JSON files trong `.kiro/hooks/`, schema
//    { version: "v1", hooks: [{ name, trigger: "PreToolUse", action: { type: "command", command } }] }.
//    GIỚI HẠN (kirodotdev/Kiro#7500): IDE runCommand hooks KHÔNG nhận tool_input -> best-effort.
//  - Copilot/VS Code (code.visualstudio.com/docs/agent-customization/hooks): project-level hooks
//    tồn tại — `.github/hooks/*.json` (Local harness, chat.useHooks ON mặc định), PreToolUse stdin
//    có tool_input, exit 2 = block. Chat/prompt-side KHÔNG chặn được -> education layer chính.
const KIRO_HOOK = join(".kiro", "hooks", "ai-guard.json");
const KIRO_STEERING = join(".kiro", "steering", "security.md");
const COPILOT_HOOK = join(".github", "hooks", "ai-guard.json");
const COPILOT_INSTR = join(".github", "copilot-instructions.md");

describe("kiro adapter (best-effort hook + steering education)", () => {
  it("detect .kiro dir", () => {
    expect(kiroAdapter.detect(mkproject({ kiro: true }))).toBe(true);
    expect(kiroAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install tạo hook PreToolUse + steering; idempotent; detail nêu best-effort", () => {
    const root = mkproject({ kiro: true });
    const r = kiroAdapter.install(root, { instructions: true });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("best-effort");
    const hook = JSON.parse(readFileSync(join(root, KIRO_HOOK), "utf8"));
    expect(hook.version).toBe("v1");
    expect(hook.hooks).toHaveLength(1);
    expect(hook.hooks[0].trigger).toBe("PreToolUse");
    expect(hook.hooks[0].action.type).toBe("command");
    expect(hook.hooks[0].action.command).toContain("check-file --tool kiro");
    expect(readFileSync(join(root, KIRO_STEERING), "utf8")).toContain("ai-guard:start");
    // idempotent: chạy lại không nhân bản hook/section
    kiroAdapter.install(root, { instructions: true });
    expect(JSON.parse(readFileSync(join(root, KIRO_HOOK), "utf8")).hooks).toHaveLength(1);
    expect((readFileSync(join(root, KIRO_STEERING), "utf8").match(/ai-guard:start/g) ?? []).length).toBe(1);
  });
  it("install --no-instructions chỉ hook; hook lạ chiếm slot -> từ chối (atomic, không ghi steering)", () => {
    const root = mkproject({ kiro: true });
    expect(kiroAdapter.install(root, { instructions: false }).ok).toBe(true);
    expect(existsSync(join(root, KIRO_STEERING))).toBe(false);
    const root2 = mkproject({ kiro: true });
    mkdirSync(join(root2, ".kiro", "hooks"), { recursive: true });
    writeFileSync(join(root2, KIRO_HOOK), JSON.stringify({
      version: "v1",
      hooks: [{ name: "mine", trigger: "PreToolUse", action: { type: "command", command: "echo hi" } }],
    }));
    const r2 = kiroAdapter.install(root2, { instructions: true });
    expect(r2.ok).toBe(false);
    expect(JSON.parse(readFileSync(join(root2, KIRO_HOOK), "utf8")).hooks[0].name).toBe("mine");
    expect(existsSync(join(root2, KIRO_STEERING))).toBe(false);
  });
  it("uninstall gỡ hook của mình, GIỮ steering (education)", () => {
    const root = mkproject({ kiro: true });
    kiroAdapter.install(root, { instructions: true });
    expect(kiroAdapter.uninstall(root).ok).toBe(true);
    expect(existsSync(join(root, KIRO_HOOK))).toBe(false);
    expect(existsSync(join(root, KIRO_STEERING))).toBe(true);
  });
  it("doctor: detail LUÔN kèm best-effort + issue ref (trước cả khi thiếu hook)", () => {
    const root = mkproject({ kiro: true });
    const before = kiroAdapter.doctor(root);
    expect(before.ok).toBe(false);
    expect(before.detail).toContain("best-effort");
    kiroAdapter.install(root, { instructions: false });
    const after = kiroAdapter.doctor(root);
    expect(after.ok).toBe(true);
    expect(after.detail).toContain("best-effort");
    expect(after.detail).toContain("kirodotdev/Kiro#7500");
    // Fix 3 (coordinator): doctor nêu trạng thái steering (ok-logic không đổi)
    expect(after.detail).toContain("thiếu steering");
    kiroAdapter.install(root, { instructions: true });
    expect(kiroAdapter.doctor(root).detail).toContain("steering security.md");
  });
});

describe("copilot adapter (education layer + agent hooks)", () => {
  it("detect .vscode dir", () => {
    expect(copilotAdapter.detect(mkproject({ vscode: true }))).toBe(true);
    expect(copilotAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install tạo hook PreToolUse + copilot-instructions; idempotent; detail nêu education layer", () => {
    const root = mkproject({ vscode: true });
    const r = copilotAdapter.install(root, { instructions: true });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("education layer");
    const hook = JSON.parse(readFileSync(join(root, COPILOT_HOOK), "utf8"));
    expect(hook.hooks.PreToolUse).toHaveLength(1);
    expect(hook.hooks.PreToolUse[0].command).toContain("check-file --tool copilot");
    expect(readFileSync(join(root, COPILOT_INSTR), "utf8")).toContain("ai-guard:start");
    copilotAdapter.install(root, { instructions: true });
    expect(JSON.parse(readFileSync(join(root, COPILOT_HOOK), "utf8")).hooks.PreToolUse).toHaveLength(1);
    expect((readFileSync(join(root, COPILOT_INSTR), "utf8").match(/ai-guard:start/g) ?? []).length).toBe(1);
  });
  it("install --no-instructions chỉ hook (không tạo copilot-instructions.md)", () => {
    const root = mkproject({ vscode: true });
    expect(copilotAdapter.install(root, { instructions: false }).ok).toBe(true);
    expect(existsSync(join(root, COPILOT_INSTR))).toBe(false);
    expect(existsSync(join(root, COPILOT_HOOK))).toBe(true);
  });
  it("uninstall: file instructions chỉ của ta -> xóa hẳn; có content user -> giữ phần user; gỡ hook", () => {
    // trường hợp 1: file do ta tạo (chỉ có section của ai-guard) -> xóa file luôn
    const root = mkproject({ vscode: true });
    copilotAdapter.install(root, { instructions: true });
    expect(copilotAdapter.uninstall(root).ok).toBe(true);
    expect(existsSync(join(root, COPILOT_INSTR))).toBe(false);
    expect(existsSync(join(root, COPILOT_HOOK))).toBe(false);
    // trường hợp 2: user có content riêng + section của ta -> bỏ section, giữ content user
    const root2 = mkproject({ vscode: true });
    mkdirSync(join(root2, ".github"), { recursive: true });
    writeFileSync(join(root2, COPILOT_INSTR), "# Team rules\n\nAlways use pnpm.\n");
    copilotAdapter.install(root2, { instructions: true });
    expect(copilotAdapter.uninstall(root2).ok).toBe(true);
    const rest = readFileSync(join(root2, COPILOT_INSTR), "utf8");
    expect(rest).toContain("Always use pnpm.");
    expect(rest).not.toContain("ai-guard:start");
  });
  it("doctor: thiếu -> not ok; sau install -> ok + detail kèm giới hạn prompt-side", () => {
    const root = mkproject({ vscode: true });
    expect(copilotAdapter.doctor(root).ok).toBe(false);
    copilotAdapter.install(root, { instructions: true });
    const d = copilotAdapter.doctor(root);
    expect(d.ok).toBe(true);
    expect(d.detail).toContain("education layer");
    expect(d.detail).toContain("không chặn được");
  });
});
