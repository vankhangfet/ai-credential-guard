import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, templatePath } from "./hooks-json";

// Factory cho adapter dạng "shim file": tool không có config hooks JSON (OpenCode, Pi) —
// intercept qua file TS shim đặt tại vị trí cố định trong project, shim spawn shared CLI.
export interface ShimAdapterSpec {
  id: string;
  label: string;
  detectDir: string; // ".opencode" | ".pi" — dấu hiệu tool đang dùng trong project
  shimRelPath: string; // posix, relative to project root: ".opencode/plugins/ai-guard.ts"
  shimTemplate: string; // tên file trong templates/: "opencode-shim.ts"
  instructionsFile?: string; // "AGENTS.md" — education layer
  instructionsTemplates: string[]; // tên theo thứ tự ưu tiên: ["opencode-instructions.md", "codex-instructions.md"]
}

export function makeShimAdapter(spec: ShimAdapterSpec): AdapterBase {
  const shimFile = join(...spec.shimRelPath.split("/"));
  // src: <repo>/src/adapters -> ../../templates; dist: <pkg>/dist/adapters -> ../../templates
  // (fallback ../../../templates — giữ nguyên candidate list của opencode cũ).
  const templateCandidates = (name: string) => [
    join(__dirname, "..", "..", "templates", name),
    join(__dirname, "..", "..", "..", "templates", name),
  ];
  return {
    id: spec.id,
    label: spec.label,
    detect: (root) => existsSync(join(root, spec.detectDir)),
    install(root: string, opts: InstallOptions): InstallResult {
      try {
        const shim = readFileSync(templatePath(...templateCandidates(spec.shimTemplate)), "utf8");
        // Atomic install: tính nội dung education TRƯỚC khi mutate file nào.
        const instrFile = spec.instructionsFile;
        let instruction: string | null = null;
        if (opts.instructions && instrFile) {
          instruction = appendMarkedSection(
            join(root, instrFile),
            readFileSync(templatePath(...spec.instructionsTemplates.flatMap(templateCandidates)), "utf8"),
          );
        }
        // Luôn ghi đè: shim là file hoàn toàn của ai-guard (không merge config user),
        // nên overwrite bằng template hiện tại vừa idempotent vừa nâng cấp được.
        const dest = join(root, shimFile);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, shim);
        if (instruction !== null && instrFile) writeFileSync(join(root, instrFile), instruction);
        return { adapter: spec.id, ok: true, detail: `shim ${shimFile} đã cài` };
      } catch (e) {
        return { adapter: spec.id, ok: false, detail: String(e) };
      }
    },
    uninstall(root: string): InstallResult {
      try {
        const dest = join(root, shimFile);
        if (!existsSync(dest)) return { adapter: spec.id, ok: true, detail: "không có shim — không có gì để gỡ" };
        // Chỉ xóa file của mình: shim lạ (không marker) tại đúng path đó thì giữ nguyên.
        if (!readFileSync(dest, "utf8").includes(MARKER)) {
          return { adapter: spec.id, ok: true, detail: "file không phải của ai-guard — không xóa" };
        }
        rmSync(dest);
        // GIỮ education file (đánh dấu follow-up; nhất quán với claude-code hiện tại).
        return { adapter: spec.id, ok: true, detail: `shim ai-guard đã gỡ (${spec.instructionsFile ?? "AGENTS.md"} giữ nguyên)` };
      } catch (e) {
        return { adapter: spec.id, ok: false, detail: String(e) };
      }
    },
    doctor(root: string) {
      const dest = join(root, shimFile);
      if (!existsSync(dest)) return { ok: false, detail: `thiếu shim ${shimFile}` };
      const ok = readFileSync(dest, "utf8").includes(MARKER);
      return { ok, detail: ok ? "shim đã cài" : `${shimFile} tồn tại nhưng không phải của ai-guard` };
    },
  };
}
