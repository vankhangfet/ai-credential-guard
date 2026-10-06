import { registerAdapter } from "./registry";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";

registerAdapter(claudeCodeAdapter);
registerAdapter(codexAdapter);

export { allAdapters, registerAdapter } from "./registry";
export type { AdapterBase, InstallOptions, InstallResult } from "./types";
