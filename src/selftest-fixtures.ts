// Fixtures dùng chung cho self-test runtime (src/commands/self-test) và test suite.
// Đặt ở src/ (không phải tests/) để dist build không phải import ngược vào tests dir.
export interface Fixture {
  name: string;
  input: string;
  expectRule?: string;   // ruleId phải xuất hiện trong findings (nếu đặt)
  expectBlocked: boolean; // có finding severity=block?
}

export const FIXTURES: Fixture[] = [
  { name: "aws-key", input: "AKIAIOSFODNN7EXAMPLE", expectRule: "aws-access-key", expectBlocked: true },
  { name: "openai", input: "sk-projabcdefghijklmnopqrstuvwx", expectRule: "openai-api-key", expectBlocked: true },
  { name: "github", input: "ghp_" + "a1".repeat(18), expectRule: "github-pat", expectBlocked: true },
  { name: "db-url", input: "postgres://u:pw@host/db", expectRule: "db-url", expectBlocked: true },
  { name: "pem", input: "-----BEGIN PRIVATE KEY-----", expectRule: "private-key", expectBlocked: true },
  { name: "slack", input: "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuv", expectRule: "slack-token", expectBlocked: true },
  { name: "jwt-warn", input: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", expectRule: "jwt", expectBlocked: false },
  { name: "clean-text", input: "viết cho tôi hàm quicksort bằng typescript", expectBlocked: false },
];
