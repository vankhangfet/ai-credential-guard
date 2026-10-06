// ai-guard shim for OpenCode — forwards tool calls + prompts to the shared ai-guard CLI.
// Verified against https://opencode.ai/docs/plugins and @opencode-ai/plugin Hooks:
//   tool.execute.before: (input: { tool, sessionID, callID }, output: { args }) — throw blocks the call.
//   chat.message: (input: { sessionID, ... }, output: { message: UserMessage, parts: Part[] }) —
//     UserMessage has NO nested parts; text lives in sibling output.parts[] as { type: "text", text }.
// Runs under Bun (OpenCode bundles it) — node:child_process is supported.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Fast-path: cài local qua `npm i -D ai-guard` — chạy process.execPath (binary node/bun đang
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
// THỰC THI (command injection). Xây MỘT chuỗi lệnh đã quote sẵn: double-quote mỗi arg + strip
// quote lồng nhau -> metachars chỉ còn là ký tự literal trong arg.
function guard(args: string[], input?: string): void {
  const { cmd, prefix } = resolveCmd();
  const viaShell = process.platform === "win32" && cmd.endsWith(".cmd");
  const r = viaShell
    ? spawnSync([cmd, ...prefix, ...args].map((a) => '"' + String(a).replace(/"/g, "") + '"').join(" "), {
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
  // lưu ý: docs chỉ chứng minh throw chặn được tool.execute.before; nếu chat.message throw không abort được thì prompt-side là best-effort
  "chat.message": async (_input: any, output: any) => {
    const text: string = (Array.isArray(output?.parts) ? output.parts : [])
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
    if (text.trim()) guard(["check-prompt", "--tool", "opencode"], text);
  },
});
