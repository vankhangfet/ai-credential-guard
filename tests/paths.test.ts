import { describe, it, expect } from "vitest";
import { isSensitivePath, globToRegex, normalizePath } from "../src/engine/paths";
import { DEFAULT_SENSITIVE_PATHS } from "../src/engine/paths";

describe("isSensitivePath", () => {
  const sensitive = [
    ".env", ".env.local", "config/.env.production", "APP.ENV",
    "server.key", "certs/prod.pem", "id_rsa", "keys/id_ed25519_github",
    "credentials.json", "gcp-credentials.yaml", "secrets/api-keys.txt", ".secrets/db",
    ".aws/credentials", ".npmrc", "service-account-prod.json",
  ];
  const ok = [
    "src/env.d.ts", "readme.md", "src/index.ts", "environment.ts",
    "keyboard.ts", "package.json", "src/main.rs",
  ];
  for (const p of sensitive) {
    it(`sensitive: ${p}`, () => {
      expect(isSensitivePath(p, DEFAULT_SENSITIVE_PATHS)).toBe(true);
    });
  }
  for (const p of ok) {
    it(`bình thường: ${p}`, () => {
      expect(isSensitivePath(p, DEFAULT_SENSITIVE_PATHS)).toBe(false);
    });
  }
  it("chuẩn hóa \\ -> / trên Windows", () => {
    expect(isSensitivePath("certs\\prod.pem", DEFAULT_SENSITIVE_PATHS)).toBe(true);
  });
  it("id_rsa.txt.readme là sensitive (prefix id_rsa)", () => {
    expect(isSensitivePath("id_rsa.txt.readme", DEFAULT_SENSITIVE_PATHS)).toBe(true);
  });
  it("drive letter và ../ bị strip trong normalizePath", () => {
    expect(normalizePath("C:\\proj\\secrets\\x.key")).toBe("proj/secrets/x.key");
    expect(normalizePath("../../outside/.env")).toBe("outside/.env");
  });
});
