import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, templatePath } from "./hooks-json";

// OpenCode không có config hooks JSON — intercept qua TS plugin shim đặt tại
// .opencode/plugins/ai-guard.ts (docs: https://opencode.ai/docs/plugins).
const SHIM_FILE = join(".opencode", "plugins", "ai-guard.ts");

export const opencodeAdapter: AdapterBase = {
  id: "opencode",
  label: "OpenCode",
  detect: (root) => existsSync(join(root, ".opencode")),
  install(root: string, opts: InstallOptions): InstallResult {
    try {
      const shim = readFileSync(templatePath(
        join(__dirname, "..", "..", "templates", "opencode-shim.ts"),
        join(__dirname, "..", "..", "..", "templates", "opencode-shim.ts"),
      ), "utf8");
      // Atomic install: tính nội dung AGENTS.md TRƯỚC khi ghi shim.
      const instruction = opts.instructions
        ? appendMarkedSection(
            join(root, "AGENTS.md"),
            readFileSync(templatePath(
              join(__dirname, "..", "..", "templates", "opencode-instructions.md"),
              join(__dirname, "..", "..", "..", "templates", "opencode-instructions.md"),
              join(__dirname, "..", "..", "templates", "codex-instructions.md"),
              join(__dirname, "..", "..", "..", "templates", "codex-instructions.md"),
            ), "utf8"),
          )
        : null;
      // Luôn ghi đè: shim là file hoàn toàn của ai-guard (không merge config user),
      // nên overwrite bằng template hiện tại vừa idempotent vừa nâng cấp được.
      const dest = join(root, SHIM_FILE);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, shim);
      if (instruction !== null) writeFileSync(join(root, "AGENTS.md"), instruction);
      return { adapter: "opencode", ok: true, detail: `shim ${SHIM_FILE} đã cài` };
    } catch (e) {
      return { adapter: "opencode", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      const dest = join(root, SHIM_FILE);
      if (!existsSync(dest)) return { adapter: "opencode", ok: true, detail: "không có shim — không có gì để gỡ" };
      // Chỉ xóa file của mình: shim lạ (không marker) tại đúng path đó thì giữ nguyên.
      if (!readFileSync(dest, "utf8").includes(MARKER)) {
        return { adapter: "opencode", ok: true, detail: "file không phải của ai-guard — không xóa" };
      }
      rmSync(dest);
      // GIỮ AGENTS.md (đánh dấu follow-up; nhất quán với claude-code hiện tại).
      return { adapter: "opencode", ok: true, detail: "shim ai-guard đã gỡ (AGENTS.md giữ nguyên)" };
    } catch (e) {
      return { adapter: "opencode", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const dest = join(root, SHIM_FILE);
    if (!existsSync(dest)) return { ok: false, detail: `thiếu shim ${SHIM_FILE}` };
    const ok = readFileSync(dest, "utf8").includes(MARKER);
    return { ok, detail: ok ? "shim đã cài" : `${SHIM_FILE} tồn tại nhưng không phải của ai-guard` };
  },
};
