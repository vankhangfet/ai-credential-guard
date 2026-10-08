# ai-credential-guard

**Stop secrets from leaking to AI models while you code.**

`ai-credential-guard` hooks into your AI coding tools and blocks API keys, passwords, private keys and connection strings **before** they are sent to the model — whether you paste them into a prompt or the agent tries to read a file like `.env`.

Works with **Claude Code, Codex CLI, OpenCode, Pi, Cline, Kiro, and GitHub Copilot (VS Code)**.

> npm package: `ai-credential-guard` · CLI command: `ai-guard`

---

## Quick start

Requires **Node.js ≥ 20**. Run in your project root:

```bash
npm i -D ai-credential-guard   # 1. install locally (fast, works offline)
npx ai-guard init              # 2. detect your AI tools and register hooks
npx ai-guard doctor            # 3. verify everything is wired up
```

Then **commit the generated config files** (e.g. `.claude/settings.json`, `.codex/hooks.json`, `.github/hooks/`, `CLAUDE.md`, `AGENTS.md`…).
Teammates who clone the repo are protected automatically after `npm i`.

No Node.js? → see [Python fallback](#no-nodejs-python-fallback).

---

## What happens when something is blocked

```
prompt / file read ──▶ ai-guard check ──▶ clean?  ──▶ sent to the model
                                      └─▶ secret found ──▶ BLOCKED (with bypass instructions)
```

If the block is intentional (e.g. you really need the agent to read `.env`), grant a temporary bypass:

```bash
npx ai-guard allow prompt --5m       # allow prompts for 5 minutes
npx ai-guard allow file .env --10m   # allow reading .env for 10 minutes
```

Bypass windows range from 1 to 1440 minutes, and **every bypass is recorded** in the audit log.

---

## What gets detected

- **50 built-in rules**: cloud keys (AWS, Google, Azure, Stripe), AI keys (OpenAI, Anthropic, OpenRouter), dev platform tokens (GitHub, GitLab, Slack, npm), database connection strings, private keys, JWTs and common config patterns.
- **Heuristics** (warn only, never block): generic `password = ...` assignments and high-entropy strings.
- **Sensitive files**: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets/**` and more.

---

## Supported tools

| Tool | Blocks prompts | Blocks file reads | Notes |
|---|:---:|:---:|---|
| Claude Code | ✅ | ✅ | |
| Codex CLI | ✅ | ✅ | |
| OpenCode | ✅ | ✅ | via plugin `.opencode/plugins/ai-guard.ts` |
| Cline | ✅ | ✅ | macOS/Linux; enable *Features → Hooks* |
| Pi | ⚠️ | ✅ | prompt blocking is best-effort |
| Kiro | ⚠️ | ⚠️ | best-effort, limited by [Kiro#7500](https://github.com/kirodotdev/Kiro/issues/7500) |
| GitHub Copilot (VS Code) | ❌ | ✅ | chat input can't be intercepted (platform limit); requires `chat.useHooks` |

---

## Configuration

Everything lives in the `.ai-guard/` folder of your project:

| File | Use it to |
|---|---|
| `rules.json` | add your own token formats (`add`), change a rule's severity (`override`), or disable a rule (`remove`). Reusing a built-in rule id replaces it. |
| `config.json` | add more sensitive file paths |
| `logs/YYYY-MM-DD.jsonl` | review the audit log — secrets are always masked (e.g. `sk-ant***k3Jg`) |

> ⚠️ A demo rule `example-internal` (matches `CORP-*`) is enabled by default — edit or remove it.

---

## Good to know

- **Fail-open:** if the engine can't run, your AI tool keeps working and a warning is printed. The guard never blocks your workflow by crashing.
- **Speed:** ~0.3–0.5 s per check with a local install. Without it, `npx` may take ~6 s per check on Windows — always install locally.
- **Uninstall:** `npx ai-guard uninstall` removes the hooks but keeps `.ai-guard/`. Adding `--purge` **deletes the audit log too, without confirmation**.

---

## No Node.js? (Python fallback)

The Python fallback protects **Claude Code and Codex only**. For all 7 tools, use the npm version.

1. Download the fallback zip from [Releases](https://github.com/vankhangfet/ai-credential-guard/releases).
2. From your project directory, run:

   ```bash
   bash /path/to/fallback/install.sh        # macOS / Linux
   powershell -File install.ps1             # Windows
   ```

Notes:
- The engine is installed at `.ai-guard/bin/engine.py`.
- If `rules.json` is missing, the engine **only warns and blocks nothing** (the installer will tell you).
- To uninstall, restore the `.aiguard.bak` backups of `.claude/settings.json` and `.codex/hooks.json` (or remove the `ai-guard` entries manually), then delete `.ai-guard/`.

<details>
<summary>Build the fallback from source</summary>

On a machine **with** Node.js:

```bash
git clone https://github.com/vankhangfet/ai-credential-guard.git
cd ai-credential-guard
npm run build && cp dist/rules.json fallback/rules.json
```

Copy the `fallback/` folder to the target machine and run the installer as above.
</details>

---

## CLI reference

| Command | Description |
|---|---|
| `init` | Set up `.ai-guard/` and register hooks for detected tools. Options: `--tools a,b,c` to choose tools, `--no-instructions` to skip guidance files. |
| `doctor` | Check the engine, rules and all registered hooks. |
| `allow prompt --Nm` | Allow prompts for N minutes (audited). |
| `allow file <path> --Nm` | Allow reading a file for N minutes (audited). |
| `check-prompt` | Scan a prompt from stdin. Exit code `2` = blocked. |
| `check-file <path>` | Check a path against sensitive-file rules. Exit code `2` = blocked. |
| `self-test` | Run the built-in test fixtures against the engine. |
| `uninstall [--purge]` | Remove hooks. `--purge` also deletes `.ai-guard/` including logs. |
| `version` | Print the version. |

---

<details>
<summary><b>Development</b></summary>

```bash
npm install && npm test && npm run build
python -m unittest discover -s fallback/tests -t .   # Python fallback tests
```

- CI: 3 OSes × Node 20/22, a Python matrix, and installer smoke tests (bash + PowerShell).
- Publish: `npm publish` (the `prepare` script builds automatically).
- Fallback zip contents: `fallback/{engine.py,install.sh,install.ps1}` + `dist/rules.json` (copied after a build).
</details>

## License

[MIT](LICENSE)
