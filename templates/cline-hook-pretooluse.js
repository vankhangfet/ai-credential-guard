#!/usr/bin/env node
// ai-guard hook for Cline — PreToolUse (file-side guard).
// Verified against Cline v3.36 hooks (https://cline.bot/blog/cline-v3-36-hooks):
//   - Hooks là các script thực thi trong .clinerules/hooks/, tên file ĐÚNG tên event,
//     KHÔNG extension, phải +x. Bật "Features > Hooks" trong Cline settings (macOS/Linux).
//   - stdin: JSON — base { clineVersion, hookName, timestamp, taskId, workspaceRoots, userId }
//     + PreToolUse: tool name & parameters (field names chưa được docs cố định -> alias-tolerant).
//   - Blocking contract: IN stdout JSON {"cancel":true,"errorMessage":"..."} — KHÔNG dùng exit code.
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

// Fast-path: cài local qua `npm i -D ai-credential-guard` — chạy process.execPath (binary node đang chạy
// hook) với resolved cli.js: nhanh hơn npx ~20x và hoạt động trên MỌI platform (kể cả win32 —
// không cần .cmd, không cần shell). Hook nằm tại <proj>/.clinerules/hooks/ nên tìm từ
// __dirname/../.. (cwd-independent) + cwd. Fallback npx chỉ khi chưa có local install: win32
// spawn không tìm được `npx` (batch script) khi tách args -> phải dùng npx.cmd + shell:true
// (guard() quote sẵn args — xem dưới); posix giữ bare npx như cũ.
function resolveCmd() {
  for (const base of [join(__dirname, "..", ".."), process.cwd()]) {
    for (const p of [
      join(base, "node_modules", "ai-guard", "dist", "cli.js"),
      join(base, "..", "node_modules", "ai-guard", "dist", "cli.js"),
    ]) {
      if (existsSync(p)) return { cmd: process.execPath, prefix: [p] };
    }
  }
  return process.platform === "win32"
    ? { cmd: "npx.cmd", prefix: ["--no-install", "ai-guard"] }
    : { cmd: "npx", prefix: ["--no-install", "ai-guard"] };
}

// Cline blocking contract (blog v3.36): stdout JSON với cancel=true chặn tool call.
function block(message) {
  process.stdout.write(JSON.stringify({ cancel: true, errorMessage: message }) + "\n");
}

// Spawns the shared CLI (qua fast-path execPath hoặc fallback npx):
//   ai-guard check-file --tool cline <path>   (stdin: original Cline PreToolUse payload)
// Exit code 2 = blocked -> in ra {"cancel":true,...} theo contract chặn của Cline.
// SECURITY: win32 npx.cmd fallback chạy qua cmd.exe (shell:true) — Node KHÔNG quote từng arg
// khi shell:true, nên arg từ payload (path/--root) chứa metachars (&, |, >...) sẽ bị cmd.exe
// THỰC THI (command injection). Xây MỘT chuỗi lệnh đã quote sẵn: token lệnh (index 0) để BARE —
// quote "npx.cmd" phá self-location của batch wrapper (npm dùng %~dp0); các arg còn lại được
// double-quote + strip `"` và `%` (chặn cả %VAR% expansion trong quotes) -> metachars chỉ còn
// là ký tự literal trong arg.
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
    // fail-open có tiếng vọng: không chặn workflow, nhưng phải thấy được
    console.error("ai-guard: engine failed to run (" + r.error.message + ") — SKIPPING check (fail-open)");
    return;
  }
  if (r.status === 2) {
    block((r.stderr || "ai-guard: blocked").trim());
    return;
  }
  if (r.status !== 0) {
    // engine crash / resolution fail — fail-open nhưng PHẢI thấy được
    console.error("ai-guard: engine exited " + r.status + " — " + (r.stderr || "").trim());
  }
}

// Payload gốc được pass-through nguyên văn cho check-file (CLI tự parse tool_input.path,
// patch headers...); shim chỉ THÊM alias coverage cho field names Cline chưa cố định.
let raw = "";
try { raw = readFileSync(0, "utf8"); } catch { /* stdin rỗng/TTY -> bỏ qua */ }

let j = null;
try { j = JSON.parse(raw); } catch { /* payload không phải JSON -> vẫn forward thẳng */ }

const params = j && (j.tool_input ?? j.toolInput ?? j.parameters ?? j.params ?? null);
const paramsObj = params && typeof params === "object" ? params : {};
const toolName =
  (typeof j?.tool_name === "string" && j.tool_name) ||
  (typeof j?.toolName === "string" && j.toolName) ||
  (typeof j?.tool === "string" && j.tool) ||
  (typeof j?.tool?.name === "string" && j.tool.name) ||
  "cline";
const path = [
  paramsObj.file_path, paramsObj.absolute_path, paramsObj.path, paramsObj.filePath, paramsObj.file,
].find(function (v) { return typeof v === "string" && v; });

// Payload có workspaceRoots — truyền --root để CLI không phụ thuộc cwd của hook process.
const wsRoot =
  Array.isArray(j && j.workspaceRoots) && typeof j.workspaceRoots[0] === "string"
    ? j.workspaceRoots[0]
    : undefined;

const args = ["check-file", "--tool", "cline"];
if (path) args.push(path);
if (wsRoot) args.push("--root", wsRoot);
guard(args, raw.trim() ? raw : JSON.stringify({ tool_name: toolName, tool_input: paramsObj }));
