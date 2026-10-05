import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProjectSpec {
  claudeCode?: boolean;
  codex?: boolean;
  opencode?: boolean;
  pi?: boolean;
  cline?: boolean;
  kiro?: boolean;
  vscode?: boolean;
  gitignore?: boolean;
}

export function mkproject(spec: ProjectSpec): string {
  const root = mkdtempSync(join(tmpdir(), "aig-proj-"));
  mkdirSync(join(root, ".ai-guard"), { recursive: true });
  if (spec.claudeCode) mkdirSync(join(root, ".claude"), { recursive: true });
  if (spec.codex) mkdirSync(join(root, ".codex"), { recursive: true });
  if (spec.opencode) mkdirSync(join(root, ".opencode"), { recursive: true });
  if (spec.pi) mkdirSync(join(root, ".pi"), { recursive: true });
  if (spec.cline) mkdirSync(join(root, ".cline"), { recursive: true });
  if (spec.kiro) mkdirSync(join(root, ".kiro"), { recursive: true });
  if (spec.vscode) mkdirSync(join(root, ".vscode"), { recursive: true });
  if (spec.gitignore) writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  return root;
}
