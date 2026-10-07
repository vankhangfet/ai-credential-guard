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

// Fast-path: cài local qua `npm i -D ai-credential-guard` — chạy process.execPath (binary node/bun đang
// chạy shim) với resolved cli.js: nhanh hơn npx ~20x (verifier đo npx --no-install ~6s/call trên
// Windows, node dist/cli.js ~300ms) và hoạt động trên MỌI platform (kể cả win32 — không cần
// .cmd, không cần shell). Fallback npx chỉ khi project chưa có local install: win32 spawn không
// tìm được `npx` (batch script) khi tách args -> phải dùng npx.cmd + shell:true (guard() quote
// sẵn args — xem dưới); posix giữ bare npx như cũ.
function resolveCmd(): { cmd: string; prefix: string[] } {
  for (const p of ["node_modules/ai-guard/dist/cli.js", "../node_modules/ai-guard/dist/cli.js"]) {
    if (existsSync(p)) return { cmd: process.execPath, prefix: [p] };
  }
  return process.platform === "win32"
    ? { cmd: "npx.cmd", prefix: ["--no-install", "ai-guard"] }
    : { cmd: "npx", prefix: ["--no-install", "ai-guard"] };
}

// Spawns the shared CLI (qua fast-path execPath hoặc fallback npx):
//   ai-guard check-file --tool <tool> <path>   (tool-side)
//   ai-guard check-prompt --tool <tool>        (prompt-side)
// Exit code 2 = blocked -> throw để caller chặn theo cơ chế của event tương ứng.
// SECURITY: win32 npx.cmd fallback chạy qua cmd.exe (shell:true) — Node KHÔNG quote từng arg
// khi shell:true, nên arg từ payload (path/--root) chứa metachars (&, |, >...) sẽ bị cmd.exe
// THỰC THI (command injection). Xây MỘT chuỗi lệnh đã quote sẵn: token lệnh (index 0) để BARE —
// quote "npx.cmd" phá self-location của batch wrapper (npm dùng %~dp0); các arg còn lại được
// double-quote + strip `"` và `%` (chặn cả %VAR% expansion trong quotes) -> metachars chỉ còn
// là ký tự literal trong arg.
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
