export interface InstallOptions {
  instructions: boolean; // write the education layer
}

export interface InstallResult {
  adapter: string;
  ok: boolean;
  detail: string;
}

export interface AdapterBase {
  id: string; // "claude-code" | "codex" | ...
  label: string; // display name: "Claude Code"
  detect(projectRoot: string): boolean; // is the tool used in the project?
  install(projectRoot: string, opts: InstallOptions): InstallResult;
  uninstall(projectRoot: string): InstallResult;
  doctor(projectRoot: string): { ok: boolean; detail: string };
}
