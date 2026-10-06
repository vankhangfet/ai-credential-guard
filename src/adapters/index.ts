import { registerAdapter } from "./registry";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { opencodeAdapter } from "./opencode";
import { piAdapter } from "./pi";
import { clineAdapter } from "./cline";
import { kiroAdapter } from "./kiro";
import { copilotAdapter } from "./copilot";

registerAdapter(claudeCodeAdapter);
registerAdapter(codexAdapter);
registerAdapter(opencodeAdapter);
registerAdapter(piAdapter);
registerAdapter(clineAdapter);
registerAdapter(kiroAdapter);
registerAdapter(copilotAdapter);

export { allAdapters, registerAdapter } from "./registry";
export type { AdapterBase, InstallOptions, InstallResult } from "./types";
