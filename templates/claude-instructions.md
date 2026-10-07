<!-- ai-guard:start -->
## Credential security (ai-guard)

- Never ask the user for real API keys, passwords, private keys, or connection strings.
- If you need environment variables, read variable names from `.env.example` — do not read `.env`.
- Do not open these files: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets/**`.
- If the user pastes a secret into the prompt, remind them to revoke it and remove it from the conversation history.
<!-- ai-guard:end -->
