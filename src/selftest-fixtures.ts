// Fixtures shared by the runtime self-test (src/commands/self-test) and the test suite.
// Placed in src/ (not tests/) so the dist build does not have to import back into the tests dir.
export interface Fixture {
  name: string;
  input: string;
  expectRule?: string;   // ruleId must appear in findings (if set)
  expectBlocked: boolean; // is there a finding with severity=block?
}

export const FIXTURES: Fixture[] = [
  { name: "aws-key", input: "AKIAIOSFODNN7EXAMPLE", expectRule: "aws-access-key", expectBlocked: true },
  { name: "openai", input: "sk-projabcdefghijklmnopqrstuvwx", expectRule: "openai-api-key", expectBlocked: true },
  { name: "github", input: "ghp_" + "a1".repeat(18), expectRule: "github-pat", expectBlocked: true },
  { name: "db-url", input: "postgres://u:pw@host/db", expectRule: "db-url", expectBlocked: true },
  { name: "pem", input: "-----BEGIN PRIVATE KEY-----", expectRule: "private-key", expectBlocked: true },
  { name: "slack", input: "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuv", expectRule: "slack-token", expectBlocked: true },
  { name: "jwt-warn", input: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", expectRule: "jwt", expectBlocked: false },
  { name: "login-pair", input: "ssh to server user name: root , password: 12345", expectRule: "login-credential-pair", expectBlocked: true },
  { name: "clean-text", input: "viết cho tôi hàm quicksort bằng typescript", expectBlocked: false },
];
