import { registerAdapter } from "./registry";
import { claudeCodeAdapter } from "./claude-code";

registerAdapter(claudeCodeAdapter);

export { allAdapters, registerAdapter } from "./registry";
export type { AdapterBase, InstallOptions, InstallResult } from "./types";
