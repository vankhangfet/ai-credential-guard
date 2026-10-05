import type { Rule } from "../../types";

export const vcsRules: Rule[] = [
  { id: "github-pat", severity: "block", description: "GitHub personal access token", pattern: "\\bgh[pousr]_[A-Za-z0-9]{36,255}\\b" },
  { id: "gitlab-token", severity: "block", description: "GitLab personal access token", pattern: "\\bglpat-[A-Za-z0-9_-]{20,}\\b" },
  { id: "bitbucket-client-secret", severity: "block", description: "Bitbucket OAuth client secret", pattern: "\\b(AT|BB)[A-Za-z0-9]{24}\\b" },
  { id: "npm-token", severity: "block", description: "npm access token", pattern: "\\bnpm_[A-Za-z0-9]{32,40}\\b" },
  { id: "pypi-token", severity: "block", description: "PyPI upload token", pattern: "\\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]+\\b" },
  { id: "docker-pat", severity: "block", description: "Docker personal access token", pattern: "\\bdckr_pat_[A-Za-z0-9_-]{20,}\\b" },
  { id: "gcp-sa-json", severity: "block", description: "GCP service account JSON (type field)", pattern: "\"type\"\\s*:\\s*\"service_account\".*\"client_email\"" },
];
