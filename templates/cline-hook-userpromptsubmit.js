#!/usr/bin/env node
// ai-guard hook for Cline — UserPromptSubmit (prompt-side guard).
// DIVERGENCE vs the original spec ("Cline has no prompt hook"): Cline v3.36 DOES have UserPromptSubmit
// (payload: prompt text + attachments) — https://cline.bot/blog/cline-v3-36-hooks — so we register it.
//   - stdin: JSON — base { clineVersion, hookName, timestamp, taskId, workspaceRoots, userId }
//     + prompt text (field name not fixed by the docs -> alias-tolerant: prompt|userPrompt|text|input|message).
//   - Blocking contract: print stdout JSON {"cancel":true,"errorMessage":"..."} — do NOT use exit code.
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

// Fast-path: the npm package is named `ai-credential-guard` (bin `ai-guard`). Bug <=1.1.0: only checked
// `node_modules/ai-guard/...` (OLD name) -> a local install never matched, every check cost
// npx ~6s/call (Windows). Fix: check the NEW name first (__dirname/../.. + cwd), keep the old name as a
// legacy fallback for alias installs (the package was never published under the name ai-guard). Run process.execPath (the node binary
// running the hook) with the resolved cli.js: ~20x faster than npx and works on ALL platforms (including
// win32 — no .cmd, no shell needed). The hook lives at <proj>/.clinerules/hooks/ so search from
// __dirname/../.. (cwd-independent) + cwd. (the hook runs via the node shebang -> execPath is always the
// node runtime, no guard needed). npx fallback only when there is no local install: win32 spawn
// cannot find `npx` (a batch script) with split args -> must use npx.cmd + shell:true
// (guard() pre-quotes args — see below); posix keeps bare npx as before.
function resolveCmd() {
  // Prefer by BASE first (closest to the hook wins); within each base, NEW name before old name.
  for (const base of [join(__dirname, "..", ".."), process.cwd()]) {
    for (const name of ["ai-credential-guard", "ai-guard"]) {
      for (const rel of [join("node_modules", name, "dist", "cli.js"), join("..", "node_modules", name, "dist", "cli.js")]) {
        const p = join(base, rel);
        if (existsSync(p)) return { cmd: process.execPath, prefix: [p] };
      }
    }
  }
  return process.platform === "win32"
    ? { cmd: "npx.cmd", prefix: ["--no-install", "ai-guard"] }
    : { cmd: "npx", prefix: ["--no-install", "ai-guard"] };
}

// Cline blocking contract (blog v3.36): stdout JSON with cancel=true blocks the prompt.
function block(message) {
  process.stdout.write(JSON.stringify({ cancel: true, errorMessage: message }) + "\n");
}

// Spawns the shared CLI (via the execPath fast-path or npx fallback):
//   ai-guard check-prompt --tool cline        (stdin: extracted prompt text)
// Exit code 2 = blocked -> print {"cancel":true,...} per Cline's blocking contract.
// SECURITY: the win32 npx.cmd fallback runs through cmd.exe (shell:true) — Node does NOT quote each arg
// when shell:true, so args from the payload (path/--root) containing metachars (&, |, >...) would be
// EXECUTED by cmd.exe (command injection). Build ONE pre-quoted command string: the command token (index 0) stays BARE —
// quoting "npx.cmd" breaks the batch wrapper's self-location (npm uses %~dp0); the remaining args are
// double-quoted + have `"` and `%` stripped (also blocks %VAR% expansion inside quotes) -> metachars become
// literal characters in the arg.
function guard(args, input) {
  const { cmd, prefix } = resolveCmd();
  const viaShell = process.platform === "win32" && cmd.endsWith(".cmd");
  const line = [cmd, ...prefix, ...args]
    .map((a, i) => (i === 0 ? String(a) : '"' + String(a).replace(/["%]/g, "") + '"'))
    .join(" ");
  const r = viaShell
    ? spawnSync(line, {
        input: input ?? "",
        encoding: "utf8",
        timeout: 10_000,
        shell: true,
      })
    : spawnSync(cmd, [...prefix, ...args], {
        input: input ?? "",
        encoding: "utf8",
        timeout: 10_000,
      });
  if (r.error) {
    // fail-open with an audible echo: do not block the workflow, but it must be visible
    console.error("ai-guard: engine failed to run (" + r.error.message + ") — SKIPPING check (fail-open)");
    return;
  }
  if (r.status === 2) {
    block((r.stderr || "ai-guard: blocked").trim());
    return;
  }
  if (r.status !== 0) {
    // engine crash / resolution fail — fail-open but it MUST be visible
    console.error("ai-guard: engine exited " + r.status + " — " + (r.stderr || "").trim());
  }
}

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch { /* empty stdin/TTY -> skip */ }

let j = null;
try { j = JSON.parse(raw); } catch { /* raw text prompt -> forward as-is */ }

// Prefer text extracted from alias fields; if JSON parses but NO alias matches -> fall back to
// scanning RAW stdin (the prompt text appears verbatim in the JSON — the CLI's extractPrompt scans raw when there is no
// alias field, so a secret embedded in the payload is still caught; safer than skipping the scan).
const text = (j
  ? [j.prompt, j.userPrompt, j.text, j.input, j.message].find(function (v) { return typeof v === "string" && v.trim(); })
  : undefined) ?? raw;

// Payload has workspaceRoots — pass --root so the CLI does not depend on the hook process cwd.
const wsRoot =
  Array.isArray(j && j.workspaceRoots) && typeof j.workspaceRoots[0] === "string"
    ? j.workspaceRoots[0]
    : undefined;

const args = ["check-prompt", "--tool", "cline"];
if (wsRoot) args.push("--root", wsRoot);
if (typeof text === "string" && text.trim()) guard(args, text);
