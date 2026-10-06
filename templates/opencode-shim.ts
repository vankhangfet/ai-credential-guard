// ai-guard shim for OpenCode — forwards tool calls + prompts to the shared ai-guard CLI.
// Verified against https://opencode.ai/docs/plugins and @opencode-ai/plugin Hooks:
//   tool.execute.before: (input: { tool, sessionID, callID }, output: { args }) — throw blocks the call.
//   chat.message: (input: { sessionID, ... }, output: { message: UserMessage, parts: Part[] }) —
//     UserMessage has NO nested parts; text lives in sibling output.parts[] as { type: "text", text }.
// Runs under Bun (OpenCode bundles it) — node:child_process is supported.
import { spawnSync } from "node:child_process";

// Spawns the shared CLI via npx (resolves the project-local install, same contract as other adapters):
//   npx --no-install ai-guard check-file --tool opencode <path>   (from tool.execute.before)
//   npx --no-install ai-guard check-prompt --tool opencode        (from chat.message)
// Exit code 2 = blocked -> throw so OpenCode surfaces the error and aborts the action.
function guard(args: string[], input?: string): void {
  const r = spawnSync("npx", ["--no-install", "ai-guard", ...args], {
    input: input ?? "",
    encoding: "utf8",
  });
  if (r.status === 2) throw new Error((r.stderr || "ai-guard: blocked").trim());
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
  "chat.message": async (_input: any, output: any) => {
    const text: string = (Array.isArray(output?.parts) ? output.parts : [])
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
    if (text.trim()) guard(["check-prompt", "--tool", "opencode"], text);
  },
});
