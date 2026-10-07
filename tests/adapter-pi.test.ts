import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { piAdapter } from "../src/adapters/pi";

// Shim path per Pi docs (configuration.md): ".pi/extensions/ | Project extensions".
const SHIM = join(".pi", "extensions", "ai-guard.ts");

describe("pi adapter", () => {
  it("detect .pi dir", () => {
    expect(piAdapter.detect(mkproject({ pi: true }))).toBe(true);
    expect(piAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install tạo shim extension chứa marker + guard hardened, idempotent", () => {
    const root = mkproject({ pi: true });
    expect(piAdapter.install(root, { instructions: false }).ok).toBe(true);
    piAdapter.install(root, { instructions: false });
    const shim = readFileSync(join(root, SHIM), "utf8");
    expect(shim).toContain("ai-guard check-file");
    expect(shim).toContain("ai-guard check-prompt");
    expect(shim).toContain("resolveCmd");
    expect(shim).toContain("timeout");
  });
  it("install với instructions -> AGENTS.md có marker section", () => {
    const root = mkproject({ pi: true });
    piAdapter.install(root, { instructions: true });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("ai-guard:start");
  });
  it("uninstall xóa shim file của mình, giữ file lạ", () => {
    const root = mkproject({ pi: true });
    piAdapter.install(root, { instructions: true });
    const res = piAdapter.uninstall(root);
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, SHIM))).toBe(false);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    // shim lạ (không marker) tại đúng path đó -> không xóa
    mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(root, SHIM), "export default function (pi: any) { pi.on('tool_call', async () => {}); }\n");
    const res2 = piAdapter.uninstall(root);
    expect(res2.ok).toBe(true);
    expect(existsSync(join(root, SHIM))).toBe(true);
  });
  it("doctor trước/sau install; shim lạ -> không phải của ai-guard", () => {
    const root = mkproject({ pi: true });
    expect(piAdapter.doctor(root).ok).toBe(false);
    piAdapter.install(root, { instructions: false });
    expect(piAdapter.doctor(root).ok).toBe(true);
    // shim lạ (không marker) -> doctor báo không phải của ai-guard
    writeFileSync(join(root, SHIM), "export default function (pi: any) { pi.on('tool_call', async () => {}); }\n");
    const d = piAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("does not belong to ai-guard");
  });
});
