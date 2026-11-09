import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { appendMarkedSection, templatePath } from "./hooks-json";

// Factory for "shim file" adapters: tools without a JSON hooks config (OpenCode, Pi) —
// intercepted via a TS shim file placed at a fixed location in the project; the shim spawns the shared CLI.
export interface ShimAdapterSpec {
  id: string;
  label: string;
  detectDir: string; // ".opencode" | ".pi" — indicates the tool is used in the project
  shimRelPath: string; // posix, relative to project root: ".opencode/plugins/ai-guard.ts"
  shimTemplate: string; // file name in templates/: "opencode-shim.ts"
  instructionsFile?: string; // "AGENTS.md" — education layer
  instructionsTemplates: string[]; // names in priority order: ["opencode-instructions.md", "codex-instructions.md"]
}

export function makeShimAdapter(spec: ShimAdapterSpec): AdapterBase {
  const shimFile = join(...spec.shimRelPath.split("/"));
  // src: <repo>/src/adapters -> ../../templates; dist: <pkg>/dist/adapters -> ../../templates
  // (fallback ../../../templates — keeps the legacy opencode candidate list).
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
        // Atomic install: compute education content BEFORE mutating any file.
        const instrFile = spec.instructionsFile;
        let instruction: string | null = null;
        if (opts.instructions && instrFile) {
          instruction = appendMarkedSection(
            join(root, instrFile),
            readFileSync(templatePath(...spec.instructionsTemplates.flatMap(templateCandidates)), "utf8"),
          );
        }
        // Always overwrite: the shim is fully owned by ai-guard (no user config merge),
        // so overwriting with the current template is both idempotent and upgrades it.
        const dest = join(root, shimFile);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, shim);
        if (instruction !== null && instrFile) writeFileSync(join(root, instrFile), instruction);
        return { adapter: spec.id, ok: true, detail: `shim ${shimFile} installed` };
      } catch (e) {
        return { adapter: spec.id, ok: false, detail: String(e) };
      }
    },
    uninstall(root: string): InstallResult {
      try {
        const dest = join(root, shimFile);
        if (!existsSync(dest)) return { adapter: spec.id, ok: true, detail: "no shim — nothing to remove" };
        // Only delete our own file: a foreign shim (no marker) at that path is left untouched.
        if (!readFileSync(dest, "utf8").includes(MARKER)) {
          return { adapter: spec.id, ok: true, detail: "file does not belong to ai-guard — not removing" };
        }
        rmSync(dest);
        // KEEP the education file (marked as follow-up; consistent with current claude-code).
        return { adapter: spec.id, ok: true, detail: `ai-guard shim removed (${spec.instructionsFile ?? "AGENTS.md"} kept)` };
      } catch (e) {
        return { adapter: spec.id, ok: false, detail: String(e) };
      }
    },
    doctor(root: string) {
      const dest = join(root, shimFile);
      if (!existsSync(dest)) return { ok: false, detail: `missing shim ${shimFile}` };
      const ok = readFileSync(dest, "utf8").includes(MARKER);
      return { ok, detail: ok ? "shim installed" : `${shimFile} exists but does not belong to ai-guard` };
    },
  };
}
