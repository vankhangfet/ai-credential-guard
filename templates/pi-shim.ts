// ai-guard shim for Pi — forwards tool calls + prompts to the shared ai-guard CLI.
// Verified against earendil-works/pi (github.com/badlogic/pi-mono) @ main:
//   docs/configuration.md + docs/extensions.md + src/core/extensions/types.ts:
//   - project extensions live in .pi/extensions/; entry = default-export factory
//     `export default function (pi: ExtensionAPI)`.
//   - tool_call: { toolName, input } — input mutable; return { block: true, reason } blocks
//     the call (handler failure also blocks, as fail-safe). read/edit/write schemas pass the
//     target as input.path.
//   - before_agent_start: { prompt } — raw user prompt text (after expansion); types define no
//     block result for this event, so a prompt-side throw is best-effort (like opencode's chat.message).
// Runs under Bun/node (Pi loads TS directly) — node:child_process is supported.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// Fast-path: the npm package is named `ai-credential-guard` (bin `ai-guard`). Bug <=1.1.0: only checked
// `node_modules/ai-guard/...` (OLD name) -> a local install never matched, every check cost
// npx ~6s/call (Windows). Fix: check the NEW name first (plugin-dir + cwd), keep the old name as a legacy
// fallback for alias installs (the package was never published under the name ai-guard).
// NOTE on bases: the plugin-dir base only works under Bun (opencode); under pi's jiti loader (import.meta.dir undefined) that base is inert — the cwd base is the effective one.
// Runtime guard (mirror opencode-shim v3): only use process.execPath when its basename is a JS runtime
// (node|bun|deno) — avoids the case where the host is a compiled executable (execPath points to itself);
// in that case try Bun.which, otherwise npx fallback.
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
  if (r.status === 2) throw new Error((r.stderr || "ai-guard: blocked").trim());
  if (r.status !== 0) {
    // engine crash / resolution fail — fail-open but it MUST be visible
    console.error("ai-guard: engine exited " + r.status + " — " + (r.stderr || "").trim());
    return;
  }
}

// Extension shape per docs: file exports a default factory receiving ExtensionAPI.
// Left untyped on purpose — the template must run standalone without a dependency
// on the @earendil-works/pi-coding-agent package.
export default function (pi: any) {
  // event.toolName = "read" | "edit" | "write" | "bash" | ... ; event.input = tool args (mutable).
  // File tools pass the target as input.path (verified tool schemas); fallbacks cover aliases.
  pi.on("tool_call", async (event: any) => {
    const args = event?.input ?? {};
    const path: unknown = args.path ?? args.filePath ?? args.file;
    if (typeof path === "string" && path) {
      try {
        guard(
          ["check-file", "--tool", "pi", path],
          JSON.stringify({ tool: event?.toolName ?? "pi", path, op: "read" }),
        );
      } catch (e) {
        // Blocked (exit 2) -> block the tool via Pi's official ToolCallEventResult.
        return { block: true, reason: e instanceof Error ? e.message : String(e) };
      }
    }
    return undefined;
  });
  // Fired after user submits prompt but before agent loop. event.prompt = raw text.
  // note: before_agent_start has no block result in the types — throw is best-effort
  // (the docs only prove fail-safe handler failure for tool_call).
  pi.on("before_agent_start", async (event: any) => {
    const text: string = typeof event?.prompt === "string" ? event.prompt : "";
    if (text.trim()) guard(["check-prompt", "--tool", "pi"], text);
  });
}
