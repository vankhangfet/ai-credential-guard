import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { templatePath } from "./hooks-json";

// Cline (v3.36+) does NOT use a Claude Code-style JSON hooks config — each event is ONE
// executable script at `.clinerules/hooks/<EventType>` (file name = event name, NO extension, must be +x).
// Sources: official blog https://cline.bot/blog/cline-v3-36-hooks + dev.to (9/2026) + maybedont.ai.
// docs.cline.bot getting-started/config.md describes a newer layout (`.cline/` containing hooks/...), so
// detect accepts BOTH `.clinerules` AND `.cline`; install always writes to `.clinerules/hooks/`
// (the layout confirmed by the most independent sources so far).
interface HookSpec {
  rel: string[]; // path components (posix) relative to project root
  template: string; // file name in templates/
}

// DIVERGENCE vs spec ("Cline does not expose a prompt hook yet"): Step 0 verified Cline v3.36 HAS
// UserPromptSubmit (payload: prompt text + attachments) -> register the prompt side too.
const HOOKS: HookSpec[] = [
  { rel: [".clinerules", "hooks", "PreToolUse"], template: "cline-hook-pretooluse.js" },
  { rel: [".clinerules", "hooks", "UserPromptSubmit"], template: "cline-hook-userpromptsubmit.js" },
];

// src: <repo>/src/adapters -> ../../templates; dist: <pkg>/dist/adapters -> ../../templates
const templateCandidates = (name: string) => [
  join(__dirname, "..", "..", "templates", name),
  join(__dirname, "..", "..", "..", "templates", name),
];

export const clineAdapter: AdapterBase = {
  id: "cline",
  label: "Cline",
  detect: (root) => existsSync(join(root, ".clinerules")) || existsSync(join(root, ".cline")),
  install(root: string, _opts: InstallOptions): InstallResult {
    try {
      // Atomic install: check EVERY slot BEFORE mutating any file. The `.clinerules/hooks/<Event>` slot
      // is the event's ONLY slot (JSON cannot be merged as with Claude Code) — if a foreign user hook
      // occupies it, REFUSE to overwrite rather than break the user's config.
      const foreign = HOOKS.map((h) => join(root, ...h.rel)).filter(
        (dest) => existsSync(dest) && !readFileSync(dest, "utf8").includes(MARKER),
      );
      if (foreign.length) {
        return {
          adapter: "cline",
          ok: false,
          detail: `user hook already exists (not overwriting): ${foreign.map((f) => f.slice(root.length + 1)).join(", ")} — merge manually and re-run`,
        };
      }
      for (const h of HOOKS) {
        const dest = join(root, ...h.rel);
        const content = readFileSync(templatePath(...templateCandidates(h.template)), "utf8");
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        chmodSync(dest, 0o755); // Cline requires the script to be executable (no-op on Windows)
      }
      // Instructions: skipped — Cline uses `.clinerules/` for rules but the layout (single file vs
      // `.clinerules/*.md` vs `.cline/rules/` in the newer docs) is inconsistent across sources;
      // a safe education location has not been determined yet (follow-up).
      return {
        adapter: "cline",
        ok: true,
        detail: "hooks PreToolUse + UserPromptSubmit installed (.clinerules/hooks/, requires Cline >=3.36 + enable Features > Hooks)",
      };
    } catch (e) {
      return { adapter: "cline", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      let removed = 0;
      for (const h of HOOKS) {
        const dest = join(root, ...h.rel);
        if (!existsSync(dest)) continue;
        // Only delete our own files: a foreign hook (no marker) in that slot is left untouched.
        if (!readFileSync(dest, "utf8").includes(MARKER)) continue;
        rmSync(dest);
        removed++;
      }
      return {
        adapter: "cline",
        ok: true,
        detail: removed ? `ai-guard hooks removed (${removed} file(s))` : "no ai-guard hooks — nothing to remove",
      };
    } catch (e) {
      return { adapter: "cline", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const missing = HOOKS.filter((h) => !existsSync(join(root, ...h.rel))).map((h) => h.rel.join("/"));
    if (missing.length) {
      return { ok: false, detail: `missing ai-guard hooks: ${missing.join(", ")} in .clinerules/hooks/` };
    }
    const foreign = HOOKS.filter((h) => !readFileSync(join(root, ...h.rel), "utf8").includes(MARKER)).map((h) => h.rel.join("/"));
    if (foreign.length) {
      return { ok: false, detail: `${foreign.join(", ")} exist but do not belong to ai-guard` };
    }
    return { ok: true, detail: "hooks installed (.clinerules/hooks/)" };
  },
};
