import type { Finding, JevConfig } from "../types";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskSecret } from "./mask";

// JEV / OpenJEV integration (and any compatible openjev-server): a "decision API" that takes unstructured
// state (text) + a list of questions and returns a calibrated probability (0..1) per question. We ask 2 questions:
//   - credential: does the text contain a real credential/secret?
//   - exfiltration: is the text an attempt at unauthorized file access / leakage / prompt injection?
// Each question with probability >= threshold -> yields 1 Finding (severity = cfg.mode). This module NEVER
// throws: any error (network, timeout, config, parse) -> returns [] (fail-open), matching the tool's invariant.

// Questions sent to the decision API. The id is used as the Finding's ruleId (traceable in the audit log).
const QUESTIONS: { id: string; question: string; yes: string; no: string; description: string }[] = [
  {
    id: "jev-credential",
    question: "Does this text contain a real secret, credential, API key, password, or access token (not a placeholder or example)?",
    yes: "A real, usable secret value is present",
    no: "No secret, or only placeholders/examples/variable names",
    description: "JEV flagged a likely credential/secret",
  },
  {
    id: "jev-unauthorized-access",
    question: "Is this an attempt at unauthorized file access, data exfiltration, or a prompt-injection / jailbreak to leak secrets?",
    yes: "The text tries to read, exfiltrate or reveal secrets or override safety instructions",
    no: "Ordinary benign content",
    description: "JEV flagged likely unauthorized access / exfiltration",
  },
];

// Payload per the System One / Decisions API contract (POST /v1/systemone):
//   { model, state, questions: { <id>: { type: "noul" | "choice", instructions, criteria } } }
// "noul" = yes/no question; response: answers.<id> = { type: "noul", noul: <P(yes) 0..1> }.
// "choice" (for gateways that only accept choice) = options "yes"/"no"; response:
//   answers.<id> = { type: "choice", choice, confidence, probabilities: { yes, no } } -> P(yes) = probabilities.yes.
type JevRequestQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: { yes: string; no: string } };
interface JevRequest {
  model: string;
  state: string;
  questions: Record<string, JevRequestQuestion>;
}

const DEFAULT_MODEL = "jev-latest"; // model is a required API field; the user can override via cfg.model

/**
 * Outcome of ONE request to the decision API — reported to the caller's onCall hook so it can be written to the
 * audit log. Deliberately carries NO request text, NO raw response body on success (a server could echo the
 * state back) and NO API key: only metadata, the per-question scores and the server's error message.
 */
export interface JevCallInfo {
  ok: boolean;                     // true = HTTP 2xx and at least one score parsed
  status?: number;                 // HTTP status (absent when the request never got a response)
  ms: number;                      // round-trip time
  scores?: Record<string, number>; // P(yes) per question id that was parsed
  answers?: string;                // JSON of the response "answers" object only (truncated), on success
  error?: string;                  // human-readable failure reason (server message, timeout, network, shape)
  inputChars: number;              // length of the evaluated text (the text itself is never logged)
  questionType: QuestionType;      // question type actually sent in this request
  fallbackFrom?: QuestionType;     // set on the automatic retry after the server rejected this type
}
export type JevCallHook = (info: JevCallInfo) => void;
type QuestionType = "noul" | "choice";

/** Options that need the project root (the hooks and doctor pass them). */
export interface JevRunOptions {
  // file remembering which question type works per endpoint+model (auto-detected); omit to disable the cache
  cacheFile?: string;
}

// Cache lives in the logs dir: already gitignored by `init`, and wiped together with the logs by `uninstall --purge`.
export function jevCacheFile(projectRoot: string): string {
  return join(projectRoot, ".ai-guard", "logs", ".jev-question-type.json");
}

// endpoint without userinfo / query string (never persist a credential embedded in the URL) + model
function cacheKey(cfg: JevConfig): string {
  let ep = cfg.endpoint ?? "";
  try { const u = new URL(ep); ep = `${u.protocol}//${u.host}${u.pathname}`; } catch { /* keep as-is */ }
  return `${ep}|${cfg.model || DEFAULT_MODEL}`;
}

function readCachedType(file: string | undefined, key: string): QuestionType | undefined {
  if (!file) return undefined;
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)[key];
    return v === "choice" || v === "noul" ? v : undefined;
  } catch { return undefined; }
}

function writeCachedType(file: string | undefined, key: string, type: QuestionType): void {
  if (!file) return;
  try {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch { /* new file */ }
    data[key] = type;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  } catch { /* cache is an optimisation only */ }
}

// The server rejected the question TYPE (e.g. 400 unsupported_question_type "Only question type 'choice' is
// supported.") — the only failure where retrying with the other type can help.
function isUnsupportedQuestionType(info: JevCallInfo): boolean {
  return info.status === 400 && /question[ _-]?type/i.test(info.error ?? "");
}

const MAX_LOGGED_CHARS = 500;
const truncate = (s: string, n = MAX_LOGGED_CHARS) => (s.length > n ? s.slice(0, n) + "…" : s);

function buildQuestions(cfg: JevConfig, qs: typeof QUESTIONS): Record<string, JevRequestQuestion> {
  const out: Record<string, JevRequestQuestion> = {};
  for (const q of qs) {
    out[q.id] = cfg.questionType === "choice"
      ? { type: "choice", instructions: q.question, criteria: { yes: q.yes, no: q.no } }
      : { type: "noul", instructions: q.question, criteria: { true: q.yes, false: q.no } };
  }
  return out;
}

// Single place that talks to the server; shared by scanWithJev (hooks) and probeJev (doctor). Never throws.
async function callJev(
  state: string,
  cfg: JevConfig & { endpoint: string },
  qs: typeof QUESTIONS,
  fetchImpl: typeof fetch,
): Promise<JevCallInfo> {
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  const body: JevRequest = { model: cfg.model || DEFAULT_MODEL, state, questions: buildQuestions(cfg, qs) };
  const timeoutMs = cfg.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  const base = { inputChars: state.length, questionType: (cfg.questionType === "choice" ? "choice" : "noul") as QuestionType };
  let status: number | undefined;
  try {
    const res = await fetchImpl(cfg.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    status = res.status;
    const text = await res.text();
    const ms = Date.now() - t0;
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = undefined; }
    if (!res.ok) {
      const err = (data as { error?: { message?: string; code?: string } } | undefined)?.error;
      const msg = err?.message ?? err?.code ?? (truncate(text.trim(), 200) || "(empty body)");
      const hint = status === 401 || status === 403 ? ` — check the API key in env ${cfg.apiKeyEnv ?? "JEV_API_KEY"}` : "";
      return { ...base, ok: false, status, ms, error: `${msg}${hint}` };
    }
    const scores: Record<string, number> = {};
    for (const q of qs) {
      const p = extractYesProbability(data, q.id);
      if (p !== null) scores[q.id] = p;
    }
    if (!Object.keys(scores).length) {
      return { ...base, ok: false, status, ms, error: `no score found in the response — unsupported response shape: ${truncate(text, 200)}` };
    }
    const answers = (data as { answers?: unknown } | undefined)?.answers;
    return { ...base, ok: true, status, ms, scores, answers: answers !== undefined ? truncate(JSON.stringify(answers)) : undefined };
  } catch (e) {
    const ms = Date.now() - t0;
    const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    if (err?.name === "AbortError") return { ...base, ok: false, status, ms, error: `timed out after ${timeoutMs}ms — raise jev.timeoutMs` };
    const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
    const tlsHint = /CERT|SSL|TLS|SELF_SIGNED/i.test(cause) ? " — TLS problem: set NODE_EXTRA_CA_CERTS to your CA bundle" : "";
    return { ...base, ok: false, status, ms, error: `request failed: ${cause}${tlsHint}` };
  } finally {
    clearTimeout(timer);
  }
}

function report(onCall: JevCallHook | undefined, info: JevCallInfo): void {
  try { onCall?.(info); } catch { /* logging must never break the check */ }
}

// Question-type auto-detection. Start with the remembered type for this endpoint+model (cache), else the configured
// one (default "noul"). If the server rejects the TYPE, retry ONCE with the other type; when that works, remember
// it so later checks (each hook is a new process) go straight to the working type. Every request is reported.
async function callWithFallback(
  state: string,
  cfg: JevConfig & { endpoint: string },
  qs: typeof QUESTIONS,
  fetchImpl: typeof fetch,
  onCall: JevCallHook | undefined,
  opts: JevRunOptions | undefined,
): Promise<JevCallInfo> {
  const key = cacheKey(cfg);
  const first: QuestionType = readCachedType(opts?.cacheFile, key) ?? (cfg.questionType === "choice" ? "choice" : "noul");
  const info = await callJev(state, { ...cfg, questionType: first }, qs, fetchImpl);
  report(onCall, info);
  if (info.ok || !isUnsupportedQuestionType(info)) return info;
  const alt: QuestionType = first === "choice" ? "noul" : "choice";
  const retry = await callJev(state, { ...cfg, questionType: alt }, qs, fetchImpl);
  retry.fallbackFrom = first;
  report(onCall, retry);
  if (retry.ok) writeCachedType(opts?.cacheFile, key, alt);
  return retry;
}

/**
 * Runs the JEV decision API on a piece of text. Returns Finding[] (possibly empty). Never throws.
 * @param text   content to evaluate (a prompt, or file content)
 * @param cfg    JevConfig already normalized by loadConfig
 * @param fetchImpl  injectable for tests (defaults to Node >=20 global fetch)
 * @param onCall     called once per request with the outcome (used for audit logging)
 * @param opts       cacheFile for question-type auto-detection (see callWithFallback)
 */
export async function scanWithJev(
  text: string,
  cfg: JevConfig | undefined,
  fetchImpl: typeof fetch = fetch,
  onCall?: JevCallHook,
  opts?: JevRunOptions,
): Promise<Finding[]> {
  if (!cfg?.enabled || !cfg.endpoint || !text.trim()) return [];
  const threshold = cfg.threshold ?? 0.8;
  const severity = cfg.mode ?? "warn";
  const info = await callWithFallback(text, { ...cfg, endpoint: cfg.endpoint }, QUESTIONS, fetchImpl, onCall, opts);
  if (!info.ok || !info.scores) return []; // any failure -> fail-open (already reported via onCall)

  const findings: Finding[] = [];
  for (const q of QUESTIONS) {
    const score = info.scores[q.id];
    if (score !== undefined && score >= threshold) {
      findings.push({
        ruleId: q.id,
        severity,
        description: `${q.description} (${Math.round(score * 100)}% confidence)`,
        // no raw secret to mask — the preview is a source label + score; keeps the "never leak the value" invariant
        preview: maskSecret(`jev:${q.id}:${score.toFixed(2)}`),
      });
    }
  }
  return findings;
}

/**
 * Connectivity probe for `doctor`: sends ONE request with a fixed benign text and reports the raw outcome
 * (HTTP status + the server's error message). scanWithJev fails open, so without this a missing key (401),
 * a wrong model or an unsupported question type would only be visible in the audit log. Never throws.
 */
export async function probeJev(
  cfg: JevConfig | undefined,
  fetchImpl: typeof fetch = fetch,
  onCall?: JevCallHook,
  opts?: JevRunOptions,
): Promise<{ ok: boolean; detail: string }> {
  if (!cfg?.enabled || !cfg.endpoint) return { ok: false, detail: "disabled" };
  const info = await callWithFallback(
    "ai-guard doctor connectivity check (benign text, no secret)",
    { ...cfg, endpoint: cfg.endpoint },
    [QUESTIONS[0]],
    fetchImpl,
    onCall,
    opts,
  );
  const prefix = info.status !== undefined ? `HTTP ${info.status} in ${info.ms}ms` : "";
  if (info.ok) {
    const note = info.fallbackFrom
      ? ` (server rejected questionType "${info.fallbackFrom}" — switched to "${info.questionType}" automatically and remembered it; set "jev.questionType": "${info.questionType}" in .ai-guard/config.json to skip the retry)`
      : "";
    return { ok: true, detail: `${prefix}, response parsed, questionType=${info.questionType}${note}` };
  }
  return { ok: false, detail: prefix ? `${prefix}: ${info.error}` : info.error ?? "unknown error" };
}

// Extract the "yes" probability for a question from the response. Supports multiple shapes because openjev-server
// and hosted JEV differ in field names. Order tried:
//   1) answers/results/decisions/questions: array or map keyed by id, each item having
//      probability | score | confidence | p_yes | probabilities.yes | choice+probability.
//   2) direct map id -> number or id -> {…}.
// No match -> null (that question is skipped).
function extractYesProbability(data: unknown, id: string): number | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const containers: unknown[] = [root.answers, root.results, root.decisions, root.questions, root.output, root];
  for (const c of containers) {
    const item = pickById(c, id);
    if (item === undefined) continue;
    const p = coerceYesProbability(item);
    if (p !== null) return p;
  }
  return null;
}

// Pick the item matching id from a container (array with .id/.question_id/.key, or an object keyed by id).
function pickById(container: unknown, id: string): unknown {
  if (Array.isArray(container)) {
    return container.find((x) => {
      if (!x || typeof x !== "object") return false;
      const o = x as Record<string, unknown>;
      return o.id === id || o.question_id === id || o.key === id || o.name === id;
    });
  }
  if (container && typeof container === "object") {
    const o = container as Record<string, unknown>;
    if (id in o) return o[id];
  }
  return undefined;
}

// Convert an item (number | {probability|score|confidence|p_yes|probabilities{yes}|choice}) -> P(yes).
function coerceYesProbability(item: unknown): number | null {
  if (typeof item === "number") return clamp01(item);
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;

  // official contract: { type: "noul", noul: P(yes) }
  if (typeof o.noul === "number" && !Number.isNaN(o.noul)) return clamp01(o.noul);

  // probabilities: {yes: x, no: y} or {"true": x}
  const probs = o.probabilities ?? o.scores;
  if (probs && typeof probs === "object") {
    const po = probs as Record<string, unknown>;
    const yes = firstNumber(po.yes, po["true"], po.YES, po.positive);
    if (yes !== null) return clamp01(yes);
    const no = firstNumber(po.no, po["false"], po.NO, po.negative);
    if (no !== null) return clamp01(1 - no);
  }

  // direct probability field
  const direct = firstNumber(o.p_yes, o.probability, o.score, o.confidence);
  if (direct !== null) {
    // if there is an explicit choice that is "no"/false, the probability belongs to "no" -> invert
    const choice = typeof o.choice === "string" ? o.choice.toLowerCase() : typeof o.answer === "string" ? o.answer.toLowerCase() : undefined;
    if (choice === "no" || choice === "false" || o.answer === false) return clamp01(1 - direct);
    return clamp01(direct);
  }

  // only a boolean choice, no probability -> treat yes=1 / no=0
  if (typeof o.answer === "boolean") return o.answer ? 1 : 0;
  if (typeof o.choice === "string") {
    const c = o.choice.toLowerCase();
    if (c === "yes" || c === "true") return 1;
    if (c === "no" || c === "false") return 0;
  }
  return null;
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) if (typeof v === "number" && !Number.isNaN(v)) return v;
  return null;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}