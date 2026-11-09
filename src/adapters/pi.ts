import { makeShimAdapter } from "./shim-adapter";

// Pi (badlogic/pi-mono, now earendil-works/pi) has no JSON hooks config — intercepted via a
// TS extension shim placed at .pi/extensions/ai-guard.ts (docs: configuration.md
// ".pi/extensions/ | Project extensions"; extensions.md: default-export factory receiving ExtensionAPI).
export const piAdapter = makeShimAdapter({
  id: "pi",
  label: "Pi",
  detectDir: ".pi",
  shimRelPath: ".pi/extensions/ai-guard.ts",
  shimTemplate: "pi-shim.ts",
  instructionsFile: "AGENTS.md",
  instructionsTemplates: ["pi-instructions.md", "opencode-instructions.md"],
});
