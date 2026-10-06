// ai-guard shim for Pi — forwards tool calls + prompts to the shared ai-guard CLI.
// Verified against earendil-works/pi (github.com/badlogic/pi-mono) @ main:
//   docs/configuration.md + docs/extensions.md + src/core/extensions/types.ts:
//   - project extensions live in .pi/extensions/; entry = default-export factory
//     `export default function (pi: ExtensionAPI)`.
//   - tool_call: { toolName, input } — input mutable; return { block: true, reason } blocks
//     the call (handler failure also blocks, as fail-safe). read/edit/write schemas pass the
//     target as input.path.
//   - before_agent_start: { prompt } — raw user prompt text (after expansion); types define no
//     block result for this event, nên prompt-side throw là best-effort (như chat.message của opencode).
// Runs under Bun/node (Pi loads TS directly) — node:child_process is supported.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Fast-path: cài local qua `npm i -D ai-guard` — chạy node trực tiếp (nhanh hơn npx ~20x;
// verifier đo npx --no-install ~6s/call trên Windows, node dist/cli.js ~300ms).
// npx --no-install ai-guard chỉ là fallback khi project chưa có local install.
function resolveCmd(): { cmd: string; prefix: string[] } {
  for (const p of ["node_modules/ai-guard/dist/cli.js", "../node_modules/ai-guard/dist/cli.js"]) {
    if (existsSync(p)) return { cmd: "node", prefix: [p] };
  }
  return { cmd: "npx", prefix: ["--no-install", "ai-guard"] };
}

// Spawns the shared CLI (qua fast-path node hoặc fallback npx):
//   ai-guard check-file --tool pi <path>   (from tool_call)
//   ai-guard check-prompt --tool pi        (from before_agent_start)
// Exit code 2 = blocked -> caller chặn theo cơ chế của từng event.
function guard(args: string[], input?: string): void {
  const { cmd, prefix } = resolveCmd();
  const r = spawnSync(cmd, [...prefix, ...args], {
    input: input ?? "",
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.error) {
    // fail-open có tiếng vọng: không chặn workflow, nhưng phải thấy được
    console.error("ai-guard: engine không chạy được (" + r.error.message + ") — BỎ QUA kiểm tra (fail-open)");
    return;
  }
  if (r.status === 2) throw new Error((r.stderr || "ai-guard: blocked").trim());
  if (r.status !== 0) {
    // engine crash / resolution fail — fail-open nhưng PHẢI thấy được
    console.error("ai-guard: engine exited " + r.status + " — " + (r.stderr || "").trim());
    return;
  }
}

// Extension shape per docs: file exports a default factory receiving ExtensionAPI.
// Left untyped on purpose — template phải chạy standalone không cần dependency
// vào package @earendil-works/pi-coding-agent.
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
        // Blocked (exit 2) -> chặn tool qua ToolCallEventResult chính thức của Pi.
        return { block: true, reason: e instanceof Error ? e.message : String(e) };
      }
    }
    return undefined;
  });
  // Fired after user submits prompt but before agent loop. event.prompt = raw text.
  // lưu ý: before_agent_start không có block result trong types — throw là best-effort
  // (docs chỉ chứng minh fail-safe handler failure cho tool_call).
  pi.on("before_agent_start", async (event: any) => {
    const text: string = typeof event?.prompt === "string" ? event.prompt : "";
    if (text.trim()) guard(["check-prompt", "--tool", "pi"], text);
  });
}
