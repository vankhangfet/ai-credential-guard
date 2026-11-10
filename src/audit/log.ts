import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent, JevConfig } from "../types";
import type { JevCallInfo } from "../engine/jev";

export function appendAuditEvent(projectRoot: string, evt: AuditEvent): void {
  try {
    const dir = join(projectRoot, ".ai-guard", "logs");
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    appendFileSync(join(dir, day + ".jsonl"), JSON.stringify(evt) + "\n");
  } catch {
    // fail-open: audit must not break the hook
  }
}

// Strip userinfo (user:pass@) and the query string (?key=...) so a credential embedded in the endpoint URL
// never reaches the log. Unparseable URL -> a fixed placeholder rather than the raw string.
export function safeEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

// One audit record per JEV / OpenJEV request (event "jev"): jev_call on success, jev_error on failure.
export function logJevCall(
  projectRoot: string,
  tool: string,
  target: "prompt" | "file" | "doctor",
  cfg: JevConfig | undefined,
  info: JevCallInfo,
  path?: string,
): void {
  appendAuditEvent(projectRoot, {
    ts: new Date().toISOString(),
    tool,
    event: "jev",
    action: info.ok ? "jev_call" : "jev_error",
    target,
    path,
    endpoint: safeEndpoint(cfg?.endpoint),
    model: cfg?.model || "jev-latest",
    questionType: cfg?.questionType ?? "noul",
    status: info.status,
    ms: info.ms,
    inputChars: info.inputChars,
    scores: info.scores,
    answers: info.answers,
    error: info.error,
  });
}

// Redact quoted fragments: Node's JSON.parse errors quote the offending input ("... is not valid JSON"), which
// could be a pasted secret. Keep the message shape, drop the content, cap the length.
export function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"').slice(0, 300);
}

// Unexpected internal error in a command (event "error"). Stack keeps only "at fn (file:line:col)" frames.
export function logInternalError(projectRoot: string, tool: string, command: string, e: unknown): void {
  const err = e as { message?: string; stack?: string };
  const stack = typeof err?.stack === "string"
    ? err.stack.split("\n").filter((l) => l.trim().startsWith("at ")).slice(0, 5).map((l) => l.trim()).join(" | ")
    : undefined;
  appendAuditEvent(projectRoot, {
    ts: new Date().toISOString(),
    tool,
    event: "error",
    action: "error",
    command,
    error: sanitizeErrorMessage(err?.message ?? String(e)),
    stack,
  });
}
