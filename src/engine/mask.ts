const PLACEHOLDER_RE =
  /^(test|tests|example|examples|sample|samples|dummy|fake|placeholder|changeme|change[-_]?me|xxx+|\*+|your[-_][a-z0-9_.-]*|(?:your|my)[-_]?(?:key|token|pass(?:word)?|secret|api[_-]?key)[a-z0-9_-]*|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\([a-z ]*\))[-_.a-z0-9]*$/i;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value.trim());
}

export function maskSecret(value: string): string {
  const s = value.trim();
  if (s.length <= 4) return "***";
  if (s.length <= 14) return s.slice(0, 2) + "***";
  return s.slice(0, 6) + "***" + s.slice(-4);
}
