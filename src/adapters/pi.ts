import { makeShimAdapter } from "./shim-adapter";

// Pi (badlogic/pi-mono, nay là earendil-works/pi) không có config hooks JSON — intercept qua
// TS extension shim đặt tại .pi/extensions/ai-guard.ts (docs: configuration.md
// ".pi/extensions/ | Project extensions"; extensions.md: default-export factory nhận ExtensionAPI).
export const piAdapter = makeShimAdapter({
  id: "pi",
  label: "Pi",
  detectDir: ".pi",
  shimRelPath: ".pi/extensions/ai-guard.ts",
  shimTemplate: "pi-shim.ts",
  instructionsFile: "AGENTS.md",
  instructionsTemplates: ["pi-instructions.md", "opencode-instructions.md"],
});
