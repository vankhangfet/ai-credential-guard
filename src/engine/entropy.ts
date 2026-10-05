export function shannonEntropy(s: string): number {
  if (!s.length) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let h = 0;
  for (const c of Object.values(freq)) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const COMMON_WORD_RE = /^[a-z][a-z\-']{5,}$/;

export function isHighEntropyToken(s: string, minLen = 20, minH = 3.5): boolean {
  if (s.length < minLen) return false;
  // bỏ token thuần chữ thường giống từ tự nhiên
  if (COMMON_WORD_RE.test(s) && shannonEntropy(s) < 4.2) return false;
  return shannonEntropy(s) >= minH;
}
