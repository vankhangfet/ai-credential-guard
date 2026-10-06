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

// Fast-path: cài local qua `npm i -D ai-guard` — chạy node trực tiếp (nhanh hơn npx ~20x;
// npx --no-install ai-guard chỉ là fallback khi project chưa có local install).
// Hook nằm tại <proj>/.clinerules/hooks/ nên tìm từ __dirname/../.. (cwd-independent) + cwd.
function resolveCmd() {
  for (const base of [join(__dirname, "..", ".."), process.cwd()]) {
    for (const p of [
      join(base, "node_modules", "ai-guard", "dist", "cli.js"),
      join(base, "..", "node_modules", "ai-guard", "dist", "cli.js"),
    ]) {
      if (existsSync(p)) return { cmd: "node", prefix: [p] };
    }
  }
  return { cmd: process.platform === "win32" ? "npx.cmd" : "npx", prefix: ["--no-install", "ai-guard"] };
}

// Cline blocking contract (blog v3.36): stdout JSON với cancel=true chặn tool call.
function block(message) {
  process.stdout.write(JSON.stringify({ cancel: true, errorMessage: message }) + "\n");
}

// Spawns the shared CLI (qua fast-path node hoặc fallback npx):
//   ai-guard check-file --tool cline <path>   (stdin: original Cline PreToolUse payload)
// Exit code 2 = blocked -> in ra {"cancel":true,...} theo contract chặn của Cline.
function guard(args, input) {
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
