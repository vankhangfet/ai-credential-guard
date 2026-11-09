import { makeShimAdapter } from "./shim-adapter";

// OpenCode has no JSON hooks config — intercepted via a TS plugin shim placed at
// .opencode/plugins/ai-guard.ts (docs: https://opencode.ai/docs/plugins).
export const opencodeAdapter = makeShimAdapter({
  id: "opencode",
  label: "OpenCode",
  detectDir: ".opencode",
  shimRelPath: ".opencode/plugins/ai-guard.ts",
  shimTemplate: "opencode-shim.ts",
  instructionsFile: "AGENTS.md",
  instructionsTemplates: ["opencode-instructions.md", "codex-instructions.md"],
});
