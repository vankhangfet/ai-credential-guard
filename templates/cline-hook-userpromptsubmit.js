#!/usr/bin/env node
// ai-guard hook for Cline — UserPromptSubmit (prompt-side guard).
// DIVERGENCE vs spec ban đầu ("Cline không có prompt hook"): Cline v3.36 CÓ UserPromptSubmit
// (payload: prompt text + attachments) — https://cline.bot/blog/cline-v3-36-hooks — nên đăng ký.
//   - stdin: JSON — base { clineVersion, hookName, timestamp, taskId, workspaceRoots, userId }
//     + prompt text (field name chưa được docs cố định -> alias-tolerant: prompt|userPrompt|text|input|message).
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

// Cline blocking contract (blog v3.36): stdout JSON với cancel=true chặn prompt.
function block(message) {
  process.stdout.write(JSON.stringify({ cancel: true, errorMessage: message }) + "\n");
}

// Spawns the shared CLI (qua fast-path node hoặc fallback npx):
//   ai-guard check-prompt --tool cline        (stdin: extracted prompt text)
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

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch { /* stdin rỗng/TTY -> bỏ qua */ }

let j = null;
try { j = JSON.parse(raw); } catch { /* raw text prompt -> forward thẳng */ }

// Ưu tiên text tách được (chắc chắn extract được phía CLI); fallback pass-through nguyên văn.
const text = j
  ? [j.prompt, j.userPrompt, j.text, j.input, j.message].find(function (v) { return typeof v === "string" && v.trim(); })
  : raw;

// Payload có workspaceRoots — truyền --root để CLI không phụ thuộc cwd của hook process.
const wsRoot =
  Array.isArray(j && j.workspaceRoots) && typeof j.workspaceRoots[0] === "string"
    ? j.workspaceRoots[0]
    : undefined;

const args = ["check-prompt", "--tool", "cline"];
if (wsRoot) args.push("--root", wsRoot);
if (typeof text === "string" && text.trim()) guard(args, text);
