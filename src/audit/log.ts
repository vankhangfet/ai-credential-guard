import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "../types";

export function appendAuditEvent(projectRoot: string, evt: AuditEvent): void {
  try {
    const dir = join(projectRoot, ".ai-guard", "logs");
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    appendFileSync(join(dir, day + ".jsonl"), JSON.stringify(evt) + "\n");
  } catch {
    // fail-open: audit không được làm hỏng hook
  }
}

export function logInternalError(projectRoot: string, err: unknown): void {
  try {
    const dir = join(projectRoot, ".ai-guard", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "error.log"), `[${new Date().toISOString()}] ${String(err)}\n`);
  } catch { /* ignore */ }
}
