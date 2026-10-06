import { registerAdapter } from "./registry";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { opencodeAdapter } from "./opencode";

registerAdapter(claudeCodeAdapter);
registerAdapter(codexAdapter);
registerAdapter(opencodeAdapter);

export { allAdapters, registerAdapter } from "./registry";
export type { AdapterBase, InstallOptions, InstallResult } from "./types";
