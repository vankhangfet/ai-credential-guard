import { isAbsolute, join, relative } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { findProjectRoot } from "../root";
import { loadConfig } from "../engine/loader";
import { isSensitivePath, normalizePath } from "../engine/paths";
import { scanWithJev } from "../engine/jev";
import { appendAuditEvent } from "../audit/log";
import { hasValidBypass } from "../bypass/store";
import { flagValue } from "../util/argv";

// apply_patch (Codex): the path lives in the patch text — "*** Update File: <path>" in each hunk header.
const PATCH_FILE_RE = /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/g;

// Collect path candidates in priority order:
// 1) argv positional (the last one, as before) — use ONLY that if present (keeps old semantics).
// 2) stdin JSON: first direct field (file_path|notebook_path|path|j.path) — explicit path wins, NO patch scan.
// 3) multi-path payloads (Kiro CLI fs_read operations[], paths[] arrays) — return EVERY path.
// 4) if there is no explicit path: EVERY patch header in tool_input.input|command|patch
//    (the caller blocks the FIRST sensitive candidate — a .env anywhere in the patch is caught).
function extractPathCandidates(argv: string[], input: string): string[] {
  // heuristic: drop flag values from positionals — future flags MUST take a value (--flag value form); boolean flags would need an update here
  const flagVals = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flagVals.add(argv[i + 1]);
  }
  const positional = argv.filter((a) => !a.startsWith("--") && !flagVals.has(a));
  if (positional.length) return [positional[positional.length - 1]];
  const s = input.trim();
  if (!s.startsWith("{")) return [];
  try {
    const j = JSON.parse(s);
    // v1: a tool_input.path that is a directory (Grep/Glob base) is blocked only if the directory name itself matches a pattern; child files are not enumerated
    // Containers in priority order: tool_input (snake/PascalCase payload — Claude/VS Code/
    // copilot PreToolUse, Kiro CLI), toolArgs (camelCase payload — copilot CLI preToolUse, typed
    // "unknown": object or JSON string), data/triggerData (Kiro IDE session-context shapes).
    // String containers are tried with JSON.parse; parse failure or non-object -> skip that container.
    const containers = [j?.tool_input, j?.toolArgs, j?.data, j?.triggerData]
      .map((c) => {
        if (typeof c === "string") {
          try { return JSON.parse(c); } catch { return undefined; }
        }
        return c;
      })
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object" && !Array.isArray(c));
    const p = containers
      .flatMap((c) => [c.file_path, c.notebook_path, c.filePath, c.path])
      .find((v) => typeof v === "string") ?? (typeof j?.path === "string" ? j.path : undefined);
    if (typeof p === "string") return [p];
    // Kiro CLI (2.x and 3.x) fs_read: tool_input = { operations: [{ mode, path }, ...] } (no top-level
    // path); also accept string arrays under paths/file_paths. Return EVERY path (caller blocks the first sensitive one).
    const multi: string[] = [];
    for (const c of containers) {
      for (const key of ["operations", "ops"]) {
        const ops = c[key];
        if (Array.isArray(ops)) {
          for (const op of ops) {
            const q = (op as Record<string, unknown> | null)?.path ?? (op as Record<string, unknown> | null)?.file_path ?? (op as Record<string, unknown> | null)?.filePath;
            if (typeof q === "string" && q) multi.push(q);
          }
        }
      }
      for (const key of ["paths", "file_paths", "filePaths"]) {
        const arr = c[key];
        if (Array.isArray(arr)) for (const q of arr) if (typeof q === "string" && q) multi.push(q);
      }
    }
    if (multi.length) return multi;
    // no explicit path — collect ALL patch headers (first-sensitive-wins in the caller)
    const ti = j?.tool_input ?? {};
    const out: string[] = [];
    for (const key of ["input", "command", "patch"]) {
      const v = ti[key] ?? j?.[key];
      if (typeof v === "string") {
        let m: RegExpExecArray | null;
        PATCH_FILE_RE.lastIndex = 0;
        while ((m = PATCH_FILE_RE.exec(v)) !== null) {
          const t = m[1].trim();
          if (t) out.push(t);
        }
      }
    }
    return out;
  } catch { return []; }
}

export async function checkFile(argv: string[], input: string): Promise<number> {
  const rootArg = flagValue(argv, "--root");
  const root = rootArg !== undefined ? rootArg : process.cwd();
  const tool = flagValue(argv, "--tool") ?? "unknown";
  const projectRoot = findProjectRoot(root);
  if (!projectRoot) return 0;
  const candidates = extractPathCandidates(argv, input);
  if (candidates.length === 0) return 0;
  const cfg = loadConfig(projectRoot);
  const jevCandidates: string[] = [];
  for (const raw of candidates) {
    const abs = isAbsolute(raw) ? raw : join(projectRoot, raw);
    const rel = normalizePath(relative(projectRoot, abs) || raw);
    if (!isSensitivePath(rel, cfg.sensitivePaths ?? [])) {
      // does not match the path gate — let JEV (if enabled) inspect the content in a later pass
      jevCandidates.push(rel);
      continue;
    }
    if (hasValidBypass(projectRoot, "file", rel)) {
      appendAuditEvent(projectRoot, { ts: new Date().toISOString(), tool, event: "file", action: "allowed_after_confirm", path: rel });
      return 0;
    }
    appendAuditEvent(projectRoot, { ts: new Date().toISOString(), tool, event: "file", action: "blocked", path: rel });
    process.stderr.write(
      [
        "ai-guard: BLOCKED — sensitive file (AI not allowed to read/write).",
        `  • Path: ${rel}`,
        "If you INTENTIONALLY want to allow this file, run:",
        `  npx ai-guard allow file ${rel} --10m`,
      ].join("\n") + "\n"
    );
    return 2;
  }
  // JEV / OpenJEV (optional, off by default): inspect the CONTENT of files that miss the path gate, catching credentials
  // accidentally written into ordinary files (e.g. src/config.ts). Fail-open: error/timeout/disabled -> no effect.
  if (cfg.jev?.enabled) {
    const jevCode = await scanCandidatesWithJev(projectRoot, tool, jevCandidates, cfg);
    if (jevCode !== 0) return jevCode;
  }
  return 0;
}

// Read each candidate's content (skip missing / oversized / bypassed files) and send it to JEV. A block
// finding -> block (exit 2); warn only -> log warned, exit 0. Never throws.
const JEV_MAX_FILE_BYTES = 256 * 1024;
async function scanCandidatesWithJev(projectRoot: string, tool: string, rels: string[], cfg: ReturnType<typeof loadConfig>): Promise<number> {
  for (const rel of rels) {
    const abs = isAbsolute(rel) ? rel : join(projectRoot, rel);
    let content = "";
    try {
      if (!existsSync(abs)) continue;
      const st = statSync(abs);
      if (!st.isFile() || st.size === 0 || st.size > JEV_MAX_FILE_BYTES) continue;
      content = readFileSync(abs, "utf8");
    } catch {
      continue; // unreadable -> fail-open
    }
    const findings = await scanWithJev(content, cfg.jev);
    if (!findings.length) continue;
    const block = findings.find((f) => f.severity === "block");
    const first = block ?? findings[0];
    const score = parseJevScore(first.description);
    const nowISO = new Date().toISOString();
    if (block) {
      if (hasValidBypass(projectRoot, "file", rel)) {
        appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "file", action: "allowed_after_confirm", path: rel, rule: first.ruleId, source: "jev", score });
        continue;
      }
      appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "file", action: "blocked", path: rel, rule: first.ruleId, source: "jev", score });
      process.stderr.write(
        [
          "ai-guard: BLOCKED — JEV flagged credential/exfiltration risk in file content.",
          `  • Path: ${rel}`,
          `  • ${first.ruleId}: ${first.description}`,
          "If you INTENTIONALLY want to allow this file, run:",
          `  npx ai-guard allow file ${rel} --10m`,
        ].join("\n") + "\n"
      );
      return 2;
    }
    // warn only
    appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "file", action: "warned", path: rel, rule: first.ruleId, source: "jev", score });
  }
  return 0;
}

// Extract the % confidence that jev.ts embeds in the description -> number 0..1.
function parseJevScore(description: string): number | undefined {
  const m = description.match(/\((\d{1,3})% confidence\)/);
  return m ? Math.max(0, Math.min(1, Number(m[1]) / 100)) : undefined;
}
