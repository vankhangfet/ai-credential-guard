export const DEFAULT_SENSITIVE_PATHS: string[] = [
  ".env", ".env.*", "*.env",
  "*.pem", "*.key", "*.p12", "*.pfx",
  "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*",
  "credentials*", "*credentials*.json", "*credentials*.yaml", "*credentials*.yml",
  "secrets/**", ".secrets/**",
  ".aws/credentials", ".npmrc", ".netrc", ".pypirc",
  "service-account*.json", "*service-account*.json",
];

export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^[a-z]:/i, "")
    .replace(/^(\.\.\/)+/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

export function globToRegex(glob: string): RegExp {
  const n = normalizePath(glob);
  let out = "";
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    if (c === "*") {
      if (n[i + 1] === "*") { out += ".*"; i++; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out + "$", "i");
}

export function isSensitivePath(path: string, patterns: string[]): boolean {
  const rel = normalizePath(path);
  for (const pat of patterns) {
    const re = globToRegex(pat);
    if (re.test(rel)) return true;
    // cho pattern không có '/': khớp cả khi file nằm trong subdir
    if (!pat.includes("/")) {
      const base = rel.split("/").pop()!;
      if (re.test(base)) return true;
    }
  }
  return false;
}
