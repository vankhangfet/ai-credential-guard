<!-- ai-guard:start -->
## Credential security (ai-guard)

- NEVER request or read real credentials: `.env`, `*.pem`, `id_rsa`, `credentials*`, API keys, passwords, private keys, connection strings.
- Need environment variables? Use `.env.example` or dummy values — do not open the real files.
- NEVER repeat a secret the user pasted into the prompt — remind them to revoke it and remove it from history.
- The ai-guard `PreToolUse` hook blocks tool calls on Kiro IDE >= 1.0.116 (older IDEs pass an empty payload and fail open) — treat this steering file as the primary guard.
<!-- ai-guard:end -->
