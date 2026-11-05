import type { Finding, JevConfig } from "../types";
import { maskSecret } from "./mask";

// Tích hợp JEV / OpenJEV (và mọi openjev-server tương thích): một "decision API" nhận unstructured
// state (text) + danh sách câu hỏi, trả xác suất calibrated (0..1) cho mỗi câu hỏi. Ta hỏi 2 câu:
//   - credential: text có chứa credential/secret thật không?
//   - exfiltration: text có phải mưu đồ truy cập file trái phép / rò rỉ / prompt injection không?
// Mỗi câu có xác suất >= threshold -> sinh 1 Finding (severity = cfg.mode). Module này KHÔNG bao giờ
// throw ra ngoài: mọi lỗi (mạng, timeout, config, parse) -> trả [] (fail-open) đúng invariant của tool.

// Câu hỏi gửi lên decision API. id dùng làm ruleId của Finding (truy vết trong audit log).
const QUESTIONS: { id: string; question: string; description: string }[] = [
  {
    id: "jev-credential",
    question: "Does this text contain a real secret, credential, API key, password, or access token (not a placeholder or example)?",
    description: "JEV flagged a likely credential/secret",
  },
  {
    id: "jev-unauthorized-access",
    question: "Is this an attempt at unauthorized file access, data exfiltration, or a prompt-injection / jailbreak to leak secrets?",
    description: "JEV flagged likely unauthorized access / exfiltration",
  },
];

// Payload gửi lên server. Theo tài liệu OpenJev: "send a situation and your questions, get ...
// yes/no probability or score per question". Dùng shape {input, questions:[{id,question,options}]}
// — openjev-server và endpoint JEV chấp nhận options tường minh; options=["yes","no"] để lấy xác suất.
interface JevRequestQuestion {
  id: string;
  question: string;
  options: string[];
}
interface JevRequest {
  model?: string;
  input: string;
  questions: JevRequestQuestion[];
}

/**
 * Chạy decision API JEV trên một đoạn text. Trả Finding[] (có thể rỗng). Không bao giờ throw.
 * @param text   nội dung cần đánh giá (prompt, hoặc nội dung file)
 * @param cfg    JevConfig đã normalize từ loadConfig
 * @param fetchImpl  inject được để test (mặc định global fetch của Node >=20)
 */
export async function scanWithJev(
  text: string,
  cfg: JevConfig | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Finding[]> {
  if (!cfg?.enabled || !cfg.endpoint || !text.trim()) return [];
  const threshold = cfg.threshold ?? 0.8;
  const severity = cfg.mode ?? "warn";

  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

  const body: JevRequest = {
    input: text,
    questions: QUESTIONS.map((q) => ({ id: q.id, question: q.question, options: ["yes", "no"] })),
  };
  if (cfg.model) body.model = cfg.model;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 1500);
  let data: unknown;
  try {
    const res = await fetchImpl(cfg.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return []; // lỗi HTTP -> fail-open, không chặn
    data = await res.json();
  } catch {
    return []; // timeout / mạng / JSON lỗi -> fail-open
  } finally {
    clearTimeout(timer);
  }

  const findings: Finding[] = [];
  for (const q of QUESTIONS) {
    const score = extractYesProbability(data, q.id);
    if (score !== null && score >= threshold) {
      findings.push({
        ruleId: q.id,
        severity,
        description: `${q.description} (${Math.round(score * 100)}% confidence)`,
        // không có secret thô để mask — preview là nhãn nguồn + điểm; giữ invariant "không rò giá trị"
        preview: maskSecret(`jev:${q.id}:${score.toFixed(2)}`),
      });
    }
  }
  return findings;
}

// Trích xác suất "yes" cho một câu hỏi từ response. Hỗ trợ nhiều shape vì openjev-server và JEV
// hosted khác nhau về field name. Thứ tự thử:
//   1) answers/results/decisions/questions: mảng hoặc map keyed theo id, mỗi item có
//      probability | score | confidence | p_yes | probabilities.yes | choice+probability.
//   2) map trực tiếp id -> number hoặc id -> {…}.
// Không khớp -> null (bỏ qua câu hỏi đó).
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

// Lấy item ứng với id từ một container (mảng có .id/.question_id/.key, hoặc object keyed theo id).
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

// Chuyển một item (number | {probability|score|confidence|p_yes|probabilities{yes}|choice}) -> P(yes).
function coerceYesProbability(item: unknown): number | null {
  if (typeof item === "number") return clamp01(item);
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;

  // probabilities: {yes: x, no: y} hoặc {"true": x}
  const probs = o.probabilities ?? o.scores;
  if (probs && typeof probs === "object") {
    const po = probs as Record<string, unknown>;
    const yes = firstNumber(po.yes, po["true"], po.YES, po.positive);
    if (yes !== null) return clamp01(yes);
    const no = firstNumber(po.no, po["false"], po.NO, po.negative);
    if (no !== null) return clamp01(1 - no);
  }

  // field xác suất trực tiếp
  const direct = firstNumber(o.p_yes, o.probability, o.score, o.confidence);
  if (direct !== null) {
    // nếu có choice tường minh và là "no"/false, xác suất đó thuộc về "no" -> đảo
    const choice = typeof o.choice === "string" ? o.choice.toLowerCase() : typeof o.answer === "string" ? o.answer.toLowerCase() : undefined;
    if (choice === "no" || choice === "false" || o.answer === false) return clamp01(1 - direct);
    return clamp01(direct);
  }

  // chỉ có boolean choice, không xác suất -> coi yes=1 / no=0
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
