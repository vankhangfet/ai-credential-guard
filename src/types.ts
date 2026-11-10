export type Severity = "block" | "warn";

export interface Rule {
  id: string;
  severity: Severity;
  pattern: string;          // empty if builtin detector
  description: string;
  builtin?: "generic-secret" | "high-entropy";
}

export interface CompiledRule extends Rule {
  re?: RegExp;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  description: string;
  preview: string;          // masked
}

export interface ProjectRules {
  add?: Rule[];
  override?: Record<string, { severity?: Severity }>;
  remove?: string[];
}

// Configuration for JEV / OpenJEV (or any openjev-server compatible server): a decision API
// that takes text + questions and returns a calibrated per-question probability. ALL optional, OFF by default ->
// not enabled unless the user configures it (keeps fail-open, offline, no-network behavior).
// The API key is NOT stored in config (this file is not gitignored by default, and the whole point of the tool is
// to keep secrets out of files) — the key is read from an environment variable (apiKeyEnv, default JEV_API_KEY).
export interface JevConfig {
  enabled?: boolean;         // default false — must be enabled explicitly
  endpoint?: string;         // decision API URL, e.g. http://localhost:8000/v1/decide
  apiKeyEnv?: string;        // name of the env variable holding the API key (default "JEV_API_KEY")
  model?: string;            // optional — select the model on openjev-server (e.g. "openjev")
  mode?: Severity;           // severity for JEV findings (default "warn" — does not hard-block by default)
  threshold?: number;        // probability threshold 0..1 to count as a detection (default 0.8)
  timeoutMs?: number;        // request timeout (default 5000) — fail-open when exceeded
  // question type sent to the server (default "noul"). Some gateways only accept "choice": the guard then sends
  // yes/no options and reads probabilities.yes from the answer.
  questionType?: "noul" | "choice";
}

export interface AiGuardConfig {
  sensitivePaths?: string[];
  genericSecret?: boolean;   // default true
  highEntropy?: boolean;     // default true
  jev?: JevConfig;           // optional external decision API (default disabled)
}

export type AuditAction =
  | "blocked" | "warned" | "bypass_granted" | "allowed_after_confirm"
  | "jev_call"   // one successful request to the JEV / OpenJEV decision API (event "jev")
  | "jev_error"  // a failed request (HTTP error, timeout, network, unparseable response) — check failed open
  | "error";     // unexpected internal error in a command (event "error") — check failed open

export interface AuditEvent {
  ts: string;
  tool: string;
  event: "prompt" | "file" | "bypass" | "jev" | "error";
  action: AuditAction;
  rule?: string;
  preview?: string;
  path?: string;
  scope?: string;
  duration_min?: number;
  count?: number;
  source?: "engine" | "jev"; // finding came from the regex engine or the JEV decision API
  score?: number;            // calibrated probability 0..1 returned by JEV (only when source="jev")
  // --- event "jev" (one record per decision-API request; never contains the text, response body or key)
  target?: "prompt" | "file" | "doctor"; // what triggered the call
  endpoint?: string;         // endpoint URL without userinfo / query string
  model?: string;
  questionType?: string;
  status?: number;           // HTTP status (absent when no response arrived)
  ms?: number;               // round-trip time
  inputChars?: number;       // size of the evaluated text
  scores?: Record<string, number>; // P(yes) per question
  answers?: string;          // JSON of the response "answers" object (truncated)
  // --- event "jev" (jev_error) and event "error"
  error?: string;
  command?: string;          // event "error": the CLI command that failed
  stack?: string;            // event "error": top stack frames (file:line only)
}
