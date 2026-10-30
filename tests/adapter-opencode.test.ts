import { describe, it, expect } from "vitest";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { opencodeAdapter } from "../src/adapters/opencode";

describe("opencode adapter", () => {
  it("detect .opencode dir", () => {
    expect(opencodeAdapter.detect(mkproject({ opencode: true }))).toBe(true);
    expect(opencodeAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install tạo shim plugin chứa marker + spawn check-file/check-prompt + fast-path đúng tên package + parts-mutation, idempotent", () => {
    const root = mkproject({ opencode: true });
    expect(opencodeAdapter.install(root, { instructions: false }).ok).toBe(true);
    opencodeAdapter.install(root, { instructions: false });
    const shim = readFileSync(join(root, ".opencode", "plugins", "ai-guard.ts"), "utf8");
    expect(shim).toContain("ai-guard check-file");
    expect(shim).toContain("ai-guard check-prompt");
    // fast-path: package tên ai-credential-guard (bug <=1.1.0 check sai node_modules/ai-guard)
    expect(shim).toContain("ai-credential-guard");
    // prompt-side: parts-mutation (chat.message throw bị silently caught — anomalyco/opencode#30434)
    expect(shim).toContain("output.parts");
    expect(shim).toContain("opencode#30434");
  });
  it("install với instructions -> AGENTS.md có marker section", () => {
    const root = mkproject({ opencode: true });
    opencodeAdapter.install(root, { instructions: true });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("ai-guard:start");
  });
  it("uninstall xóa shim file, giữ AGENTS.md khác", () => {
    const root = mkproject({ opencode: true });
    opencodeAdapter.install(root, { instructions: true });
    const res = opencodeAdapter.uninstall(root);
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, ".opencode", "plugins", "ai-guard.ts"))).toBe(false);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
  });
  it("doctor: shim tồn tại -> ok", () => {
    const root = mkproject({ opencode: true });
    expect(opencodeAdapter.doctor(root).ok).toBe(false);
    opencodeAdapter.install(root, { instructions: false });
    expect(opencodeAdapter.doctor(root).ok).toBe(true);
  });
  it("doctor: shim file lạ (không marker) -> ok false", () => {
    const root = mkproject({ opencode: true });
    require("node:fs").mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    require("node:fs").writeFileSync(join(root, ".opencode", "plugins", "ai-guard.ts"), "export const X = async () => ({});\n");
    const d = opencodeAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("does not belong to ai-guard");
  });
  it("uninstall: shim file lạ (không marker) -> không xóa", () => {
    const root = mkproject({ opencode: true });
    require("node:fs").mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    require("node:fs").writeFileSync(join(root, ".opencode", "plugins", "ai-guard.ts"), "export const X = async () => ({});\n");
    const res = opencodeAdapter.uninstall(root);
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, ".opencode", "plugins", "ai-guard.ts"))).toBe(true);
  });
});

// Fix (review Task 5): vitest THỰC THI template thật để lock parts-mutation + fast-path
// contract (cline precedent). CẦN `npm run build` trước (shim spawn dist/cli.js qua fast-path
// node_modules/ai-credential-guard); dist thiếu -> skip (it.skipIf).
const DIST_CLI = join(__dirname, "..", "dist", "cli.js");
const DIST_DIR = join(__dirname, "..", "dist");

describe("opencode shim (thực thi — lock parts-mutation + fast-path contract)", () => {
  it.skipIf(!existsSync(DIST_CLI))("chat.message: prompt có secret -> MỌI text part bị thay bằng generic notice, KHÔNG throw, secret không còn", async () => {
    const root = mkproject({ opencode: true });
    opencodeAdapter.install(root, { instructions: false });
    cpSync(DIST_DIR, join(root, "node_modules", "ai-credential-guard", "dist"), { recursive: true });
    const { AiGuardOpenCode } = await import("../templates/opencode-shim");
    const hooks = await AiGuardOpenCode();
    const parts = [
      { type: "text", text: "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi" },
      { type: "text", text: "second part" },
      { type: "image", url: "x" },
    ];
    const output = { parts };
    const cwd = process.cwd();
    let threw = false;
    try {
      process.chdir(root); // resolveCmd: cwd base trúng fast-path (plugin-dir base trỏ về repo, không có)
      await hooks["chat.message"]({}, output);
    } catch { threw = true; } finally { process.chdir(cwd); }
    expect(threw).toBe(false);
    expect(parts[0].text).toContain("ai-guard: BLOCKED");
    expect(parts[0].text).not.toContain("IOSFODNN7EXAMPLE");
    expect(parts[0].text).not.toContain("preview"); // notice generic — không đưa preview (kể cả masked) vào model
    expect(parts[0].text).not.toContain("allow prompt"); // không đưa lệnh bypass vào model
    expect(parts[1].text).toContain("ai-guard: BLOCKED");
    expect(JSON.stringify(parts[2])).toBe(JSON.stringify({ type: "image", url: "x" }));
  });
  it.skipIf(!existsSync(DIST_CLI))("chat.message: prompt sạch -> text đi qua nguyên vẹn", async () => {
    const root = mkproject({ opencode: true });
    opencodeAdapter.install(root, { instructions: false });
    cpSync(DIST_DIR, join(root, "node_modules", "ai-credential-guard", "dist"), { recursive: true });
    const { AiGuardOpenCode } = await import("../templates/opencode-shim");
    const hooks = await AiGuardOpenCode();
    const parts = [{ type: "text", text: "giúp tôi viết hàm sort" }];
    const output = { parts };
    const cwd = process.cwd();
    try {
      process.chdir(root);
      await hooks["chat.message"]({}, output);
    } finally { process.chdir(cwd); }
    expect(parts[0].text).toBe("giúp tôi viết hàm sort");
  });
  it.skipIf(!existsSync(DIST_CLI))("tool.execute.before: đọc .env qua fast-path -> throw (chặn)", async () => {
    const root = mkproject({ opencode: true });
    writeFileSync(join(root, ".env"), "X=1\n");
    opencodeAdapter.install(root, { instructions: false });
    cpSync(DIST_DIR, join(root, "node_modules", "ai-credential-guard", "dist"), { recursive: true });
    const { AiGuardOpenCode } = await import("../templates/opencode-shim");
    const hooks = await AiGuardOpenCode();
    const cwd = process.cwd();
    let err: any = null;
    try {
      process.chdir(root);
      await hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: join(root, ".env") } });
    } catch (e) { err = e; } finally { process.chdir(cwd); }
    expect(err).toBeTruthy();
    expect(String(err?.message ?? "")).toContain("ai-guard");
    expect((err as any).blocked).toBe(true); // chat.message phân biệt block thật vs bug qua tag này
  });
});
