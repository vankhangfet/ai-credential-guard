// ai-guard shim for OpenCode — forwards tool calls + prompts to the shared ai-guard CLI.
// Verified against https://opencode.ai/docs/plugins and @opencode-ai/plugin Hooks:
//   tool.execute.before: (input: { tool, sessionID, callID }, output: { args }) — throw blocks the call.
//   chat.message: (input: { sessionID, ... }, output: { message: UserMessage, parts: Part[] }) —
//     UserMessage has NO nested parts; text lives in sibling output.parts[] as { type: "text", text }.
//     Throw KHÔNG chặn được (silently caught — anomalyco/opencode#30434): block = mutate
//     output.parts in place (text parts -> block notice) để secret không tới model.
// Runs under Bun (OpenCode bundles it) — node:child_process is supported.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// Fast-path: package npm tên `ai-credential-guard` (bin `ai-guard`). Bug <=1.1.0: chỉ check
// `node_modules/ai-guard/...` (tên CŨ) -> local install không bao giờ match, mọi check trả
// npx ~6s/call (Windows). Fix: check tên MỚI trước (plugin-dir + cwd), giữ tên cũ làm legacy
// fallback cho alias install (package chưa từng publish dưới tên ai-guard).
// GIỚI HẠN runtime (Bun compiled executable): OpenCode phát hành dạng single binary — trong
// compiled exe, process.execPath trỏ về CHÍNH binary OpenCode, KHÔNG phải node/bun runtime:
// spawn nó với cli.js là unknown command -> fail-open (hoặc treo tới timeout). Chỉ dùng
// fast-path khi basename(execPath) là JS runtime (node|bun|deno); nếu không, thử
// Bun.which("node"|"bun") (plugin chạy trong process có Bun global); còn lại npx fallback.
// Base ưu tiên import.meta.dir (thư mục plugin <proj>/.opencode/plugins — cwd-independent),
// fallback process.cwd() (hành vi cũ).
function resolveCmd(): { cmd: string; prefix: string[] } {
  let runtime: string | undefined = /node|bun|deno/i.test(basename(process.execPath)) ? process.execPath : undefined;
  if (!runtime) {
    const bun = (globalThis as any).Bun;
    if (bun?.which) runtime = bun.which("node") ?? bun.which("bun") ?? undefined;
  }
  const pluginDir = (import.meta as any).dir; // Bun/vitest: dir của file này; plain node ESM: undefined
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
    console.error("ai-guard: engine failed to run (" + r.error.message + ") — SKIPPING check (fail-open)");
    return;
  }
  if (r.status === 2) {
    const e = new Error((r.stderr || "ai-guard: blocked").trim()) as Error & { blocked: boolean };
    e.blocked = true; // chat.message phân biệt block THẬT vs bug trong guard (fail-open)
    throw e;
  }
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
  // HẠNG MỎNG: throw trong chat.message bị OpenCode silently catch (anomalyco/opencode#30434,
  // closed not-planned) — KHÔNG chặn được message. Giải pháp thật (community-confirmed):
  // mutate output.parts in place — thay text của MỌI text part bằng block notice -> secret
  // KHÔNG bao giờ tới model (model nhận notice thay vì credential). Notice tới model phải
  // GENERIC: không preview (kể cả masked — mảnh secret không nên tới model), KHÔNG kèm lệnh
  // bypass (tránh agent tự mở khóa theo hướng dẫn trong notice); chi tiết đầy đủ (rule +
  // preview masked + lệnh allow) chỉ console.error cho NGƯỜI. Bug bất ngờ trong guard ->
  // log + fail-open (không thay message của user bằng noise). Shape parts đổi (không còn
  // mảng text parts) -> bỏ qua, message đi qua như cũ.
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
        // bug bất ngờ trong guard — KHÔNG thay message của user bằng noise; fail-open có tiếng vọng
        console.error("ai-guard: guard error (fail-open) — " + String((blocked as Error)?.message ?? blocked));
        return;
      }
      // Notice tới MODEL phải GENERIC: không preview (dù masked — mảnh secret không nên tới
      // model) và KHÔNG kèm lệnh bypass (tránh agent tự mở khóa theo hướng dẫn trong notice).
      // Chi tiết đầy đủ (rule + preview masked + lệnh allow) chỉ ra console.error cho NGƯỜI.
      const notice = "ai-guard: BLOCKED — credential detected in prompt; text removed before reaching the model.";
      for (const p of parts) {
        if (p?.type === "text" && typeof p.text === "string") p.text = notice;
      }
      console.error(notice + "\n" + String((blocked as Error)?.message ?? ""));
    }
  },
});
