export interface InstallOptions {
  instructions: boolean; // ghi education layer
}

export interface InstallResult {
  adapter: string;
  ok: boolean;
  detail: string;
}

export interface AdapterBase {
  id: string; // "claude-code" | "codex" | ...
  label: string; // hiển thị: "Claude Code"
  detect(projectRoot: string): boolean; // tool đang dùng trong project?
  install(projectRoot: string, opts: InstallOptions): InstallResult;
  uninstall(projectRoot: string): InstallResult;
  doctor(projectRoot: string): { ok: boolean; detail: string };
}
