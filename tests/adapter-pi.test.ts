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
  it("install creates shim extension with marker + hardened guard, idempotent", () => {
    const root = mkproject({ pi: true });
    expect(piAdapter.install(root, { instructions: false }).ok).toBe(true);
    piAdapter.install(root, { instructions: false });
    const shim = readFileSync(join(root, SHIM), "utf8");
    expect(shim).toContain("ai-guard check-file");
    expect(shim).toContain("ai-guard check-prompt");
    expect(shim).toContain("resolveCmd");
    // fast-path: package named ai-credential-guard + runtime guard (mirrors opencode-shim v3)
    expect(shim).toContain("ai-credential-guard");
    expect(shim).toContain("import.meta");
    expect(shim).toContain("timeout");
  });
  it("install with instructions -> AGENTS.md has marker section", () => {
    const root = mkproject({ pi: true });
    piAdapter.install(root, { instructions: true });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("ai-guard:start");
  });
  it("uninstall deletes own shim file, keeps foreign files", () => {
    const root = mkproject({ pi: true });
    piAdapter.install(root, { instructions: true });
    const res = piAdapter.uninstall(root);
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, SHIM))).toBe(false);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    // foreign shim (no marker) at that exact path -> not deleted
    mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(root, SHIM), "export default function (pi: any) { pi.on('tool_call', async () => {}); }\n");
    const res2 = piAdapter.uninstall(root);
    expect(res2.ok).toBe(true);
    expect(existsSync(join(root, SHIM))).toBe(true);
  });
  it("doctor before/after install; foreign shim -> not ai-guard's", () => {
    const root = mkproject({ pi: true });
    expect(piAdapter.doctor(root).ok).toBe(false);
    piAdapter.install(root, { instructions: false });
    expect(piAdapter.doctor(root).ok).toBe(true);
    // foreign shim (no marker) -> doctor reports it does not belong to ai-guard
    writeFileSync(join(root, SHIM), "export default function (pi: any) { pi.on('tool_call', async () => {}); }\n");
    const d = piAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("does not belong to ai-guard");
  });
});
