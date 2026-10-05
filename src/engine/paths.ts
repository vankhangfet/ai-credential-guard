export const DEFAULT_SENSITIVE_PATHS: string[] = [
  ".env", ".env.*", "*.env",
  "*.pem", "*.key", "*.p12", "*.pfx",
  "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*",
  "credentials*", "*credentials*.json", "*credentials*.yaml", "*credentials*.yml",
  "secrets/**", ".secrets/**",
  ".aws/credentials", ".npmrc", ".netrc", ".pypirc",
  "service-account*.json", "*service-account*.json",
];
