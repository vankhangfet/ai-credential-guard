const PLACEHOLDER_RE =
  /^(test|tests|example|examples|sample|samples|dummy|fake|placeholder|change[-_]?me|xxx+|\*+|your[-_][a-z0-9_.-]*|(?:your|my)[-_]?(?:key|token|pass(?:word)?|secret|api[_-]?key)[a-z0-9_-]*|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\([a-z ]*\))[-_.a-z0-9]*$/i;

export function isPlaceholder(value: string): boolean {
  // placeholder là token ngắn do con người đặt; giá trị dài >200 ký tự coi như thật
  if (value.length > 200) return false;
  return PLACEHOLDER_RE.test(value.trim());
}

export function maskSecret(value: string): string {
  const s = value.trim();
  if (s.length <= 4) return "***";
  if (s.length <= 14) return s.slice(0, 2) + "***";
  return s.slice(0, 6) + "***" + s.slice(-4);
}
