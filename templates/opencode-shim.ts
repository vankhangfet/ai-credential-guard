// ai-guard shim for OpenCode — forwards tool calls + prompts to the shared ai-guard CLI.
// Verified against https://opencode.ai/docs/plugins and @opencode-ai/plugin Hooks:
//   tool.execute.before: (input: { tool, sessionID, callID }, output: { args }) — throw blocks the call.
//   chat.message: (input: { sessionID, ... }, output: { message: UserMessage, parts: Part[] }) —
//     UserMessage has NO nested parts; text lives in sibling output.parts[] as { type: "text", text }.
//     Throw does NOT block (silently caught — anomalyco/opencode#30434): block = mutate
//     output.parts in place (text parts -> block notice) so the secret never reaches the model.
// Runs under Bun (OpenCode bundles it) — node:child_process is supported.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// Fast-path: the npm package is named `ai-credential-guard` (bin `ai-guard`). Bug <=1.1.0: only checked
// `node_modules/ai-guard/...` (OLD name) -> a local install never matched, every check cost
// npx ~6s/call (Windows). Fix: check the NEW name first (plugin-dir + cwd), keep the old name as a legacy
// fallback for alias installs (the package was never published under the name ai-guard).
// Runtime LIMITATION (Bun compiled executable): OpenCode ships as a single binary — in a
// compiled exe, process.execPath points to the OpenCode binary ITSELF, NOT a node/bun runtime:
// spawning it with cli.js is an unknown command -> fail-open (or hangs until timeout). Only use the
// fast-path when basename(execPath) is a JS runtime (node|bun|deno); otherwise try
// Bun.which("node"|"bun") (the plugin runs in a process with the Bun global); else npx fallback.
// Base prefers import.meta.dir (plugin dir <proj>/.opencode/plugins — cwd-independent),
// falling back to process.cwd() (old behavior).
function resolveCmd(): { cmd: string; prefix: string[] } {
  let runtime: string | undefined = /node|bun|deno/i.test(basename(process.execPath)) ? process.execPath : undefined;
  if (!runtime) {
    const bun = (globalThis as any).Bun;
    if (bun?.which) runtime = bun.which("node") ?? bun.which("bun") ?? undefined;
  }
  const pluginDir = (import.meta as any).dir; // Bun/vitest: dir of this file; plain node ESM: undefined
  const bases = [typeof pluginDir === "string" ? join(pluginDir, "..", "..") : "", process.cwd()];
  if (runtime) {
    for (const base of bases) {
      if (!base) continue;
      for (const name of ["ai-credential-guard", "ai-guard"]) {
        const p = join(base, "node_modules", name, "dist", "cli.js");
        if (existsSync(p)) return { cmd: runtime, prefix: [p] };
      }
    }
  }
  return process.platform === "win32"
    ? { cmd: "npx.cmd", prefix: ["--no-install", "ai-guard"] }
    : { cmd: "npx", prefix: ["--no-install", "ai-guard"] };
}

// Spawns the shared CLI (via the execPath fast-path or npx fallback):
//   ai-guard check-file --tool <tool> <path>   (tool-side)
//   ai-guard check-prompt --tool <tool>        (prompt-side)
// Exit code 2 = blocked -> throw so the caller blocks via the mechanism of the corresponding event.
// SECURITY: the win32 npx.cmd fallback runs through cmd.exe (shell:true) — Node does NOT quote each arg
// when shell:true, so args from the payload (path/--root) containing metachars (&, |, >...) would be
// EXECUTED by cmd.exe (command injection). Build ONE pre-quoted command string: the command token (index 0) stays BARE —
// quoting "npx.cmd" breaks the batch wrapper's self-location (npm uses %~dp0); the remaining args are
// double-quoted + have `"` and `%` stripped (also blocks %VAR% expansion inside quotes) -> metachars become
// literal characters in the arg.
function guard(args: string[], input?: string): void {
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
    const e = new Error((r.stderr || "ai-guard: blocked").trim()) as Error & { blocked: boolean };
    e.blocked = true; // chat.message distinguishes a REAL block from a bug in the guard (fail-open)
    throw e;
  }
  if (r.status !== 0) {
    // engine crash / resolution fail — fail-open but it MUST be visible
    console.error("ai-guard: engine exited " + r.status + " — " + (r.stderr || "").trim());
    return;
  }
}

// Plugin shape per docs: a plugin file exports one or more plugin functions
// `(input: PluginInput, options?) => Promise<Hooks>`. Left untyped on purpose —
// this template must run standalone without a dependency on @opencode-ai/plugin.
export const AiGuardOpenCode = async () => ({
  // input.tool = tool name ("read" | "edit" | "write" | ...); output.args = tool args (mutable).
  // File tools pass the target as args.filePath (docs example), fallbacks cover aliases.
  "tool.execute.before": async (input: any, output: any) => {
    const args = output?.args ?? {};
    const path: unknown = args.filePath ?? args.path ?? args.file;
    if (typeof path === "string" && path) {
      guard(
        ["check-file", "--tool", "opencode", path],
        JSON.stringify({ tool: input?.tool ?? "opencode", path, op: "read" }),
      );
    }
  },
  // Fires when a new (user) message is received. Extract text parts from output.parts.
  // CAVEAT: a throw in chat.message is silently caught by OpenCode (anomalyco/opencode#30434,
  // closed not-planned) — it CANNOT block the message. The real solution (community-confirmed):
  // mutate output.parts in place — replace the text of EVERY text part with a block notice -> the secret
  // NEVER reaches the model (the model gets the notice instead of the credential). The notice to the model must be
  // GENERIC: no preview (even masked — a fragment of the secret should not reach the model), NO bypass
  // command (so the agent cannot unlock itself from instructions in the notice); full details (rule +
  // masked preview + allow command) go to console.error for the HUMAN only. Unexpected bug in the guard ->
  // log + fail-open (do not replace the user's message with noise). If the parts shape changes (no longer an
  // array of text parts) -> skip, the message passes through as before.
  "chat.message": async (_input: any, output: any) => {
    const parts: any[] = Array.isArray(output?.parts) ? output.parts : [];
    const text: string = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
    if (!text.trim()) return;
    try {
      guard(["check-prompt", "--tool", "opencode"], text);
    } catch (blocked) {
      if (!(blocked as any)?.blocked) {
        // unexpected bug in the guard — do NOT replace the user's message with noise; fail-open with an audible echo
        console.error("ai-guard: guard error (fail-open) — " + String((blocked as Error)?.message ?? blocked));
        return;
      }
      // The notice to the MODEL must be GENERIC: no preview (even masked — a fragment of the secret should not reach
      // the model) and NO bypass command (so the agent cannot unlock itself from instructions in the notice).
      // Full details (rule + masked preview + allow command) go to console.error for the HUMAN only.
      const notice = "ai-guard: BLOCKED — credential detected in prompt; text removed before reaching the model.";
      for (const p of parts) {
        if (p?.type === "text" && typeof p.text === "string") p.text = notice;
      }
      console.error(notice + "\n" + String((blocked as Error)?.message ?? ""));
    }
  },
});
