import { describe, it, expect } from "vitest";
import { builtInRules, compileRules } from "../src/engine/rules";

const cases: Array<[string, string, boolean]> = [
  // [ruleId, input, shouldMatch]
  ["aws-access-key", "này là key AKIAIOSFODNN7EXAMPLE đấy", true],
  ["aws-access-key", "AKIA không đủ dài AKIAIOSFODNN7EXAMP", false],
  ["google-api-key", "AIzaSyA1234567890abcdefghijklmnopqrstuv", true],
  ["openai-api-key", "sk-projabcdefghijklmnopqrstuvwx", true],
  ["openai-api-key", "sk-ant-api03-fake-key-đủ-dài-abcdefgh", false], // anthropic, không phải openai
  ["anthropic-key", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", true],
  ["github-pat", "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB", true],
  ["slack-token", "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuv", true],
  ["db-url", "postgresql://admin:P@ssw0rd@db.example.com/prod", true],
  ["db-url", "postgresql://localhost/mydb (không có password)", false],
  ["private-key", "-----BEGIN RSA PRIVATE KEY-----", true],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", true],
  ["stripe-live", "sk_live_abcdefghijklmnopqrstuvwx", true],
  ["mongodb-url", "mongodb+srv://user:secret@cluster0.xyz.mongodb.net/", true],
  ["npm-token", "npm_1234567890123456789012345678901234", true],
];

describe("builtInRules", () => {
  const compiled = compileRules(builtInRules);
  it("id không trùng", () => {
    const ids = builtInRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  for (const [ruleId, input, shouldMatch] of cases) {
    it(`${ruleId} ${shouldMatch ? "khớp" : "không khớp"}: ${input.slice(0, 40)}`, () => {
      const rule = compiled.find((r) => r.id === ruleId);
      expect(rule, "rule phải tồn tại: " + ruleId).toBeTruthy();
      expect(!!rule!.re!.test(input)).toBe(shouldMatch);
    });
  }
  it("đủ 10 nhóm đại diện (≥1 rule mỗi nhóm chính)", () => {
    for (const id of ["aws-access-key", "openai-api-key", "github-pat", "slack-token",
      "db-url", "private-key", "jwt", "stripe-live", "gitlab-token", "hf-token"]) {
      expect(compiled.some((r) => r.id === id), id).toBe(true);
    }
  });
});
