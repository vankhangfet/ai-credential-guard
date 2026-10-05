import type { Rule } from "../../types";

export const keyRules: Rule[] = [
  { id: "private-key", severity: "block", description: "Private key PEM block", pattern: "-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----" },
  { id: "ssh-private-inline", severity: "block", description: "SSH private key JSON/escaped", pattern: "-----BEGIN OPENSSH PRIVATE KEY-----|\\\\u002d\\\\u002d\\\\u002d\\\\u002d\\\\u002dBEGIN" },
  { id: "p12-b64", severity: "warn", description: "PKCS12 blob khả nghi", pattern: "MII[A-Za-z0-9+/=]{200,}" },
];
