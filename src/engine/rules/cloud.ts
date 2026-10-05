import type { Rule } from "../../types";

export const cloudRules: Rule[] = [
  { id: "aws-access-key", severity: "block", description: "AWS Access Key ID", pattern: "\\bAKIA[0-9A-Z]{16}\\b" },
  { id: "google-api-key", severity: "block", description: "Google API key", pattern: "\\bAIza[0-9A-Za-z_-]{35}\\b" },
  { id: "google-oauth", severity: "block", description: "Google OAuth refresh token", pattern: "\\b1//[0-9A-Za-z_-]{60,}\\b" },
  { id: "azure-storage", severity: "block", description: "Azure storage connection string", pattern: "AccountKey=[A-Za-z0-9+/=]{50,}" },
  { id: "azure-client-secret", severity: "block", description: "Azure client secret", pattern: "\\b[A-Za-z0-9_~.-]{8}Q~[A-Za-z0-9_~.-]{30,}\\b" },
  { id: "gcp-service-account", severity: "block", description: "GCP service account private key id", pattern: "\"private_key_id\"\\s*:\\s*\"[0-9a-f]{40}\"" },
];
