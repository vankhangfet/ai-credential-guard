# ai-credential-guard

> Published as `ai-credential-guard` on npm — the binary is `ai-guard`, so all commands stay `npx ai-guard ...`.

Stop credentials from leaking to AI providers while you work with AI coding tools. ai-credential-guard hooks into the **prompt** and **file-read** path of 7 tools — **Claude Code, Codex CLI, OpenCode, Pi, Cline, Kiro, GitHub Copilot (VS Code)** — and blocks API keys, passwords, private keys, and connection strings *before* they reach the model. Deliberate overrides are allowed through a time-window bypass that is always recorded in an audit log.

## Install (2 main commands, requires Node ≥ 20)

```bash
npm i -D ai-credential-guard   # local install — hooks run offline, ~0.3–0.5s per call (recommended)
npx ai-guard init              # auto-detects the AI tools in your project and registers hooks
npx ai-guard doctor            # verify hooks + engine
```

Then **commit the generated hook config files** (`.claude/settings.json`, `.codex/hooks.json`, `.opencode/`, `.pi/`, `.clinerules/hooks/`, `.kiro/`, `.github/hooks/`, `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`). Teammates who clone the repo are already protected — they just run `npm i`.

No Node on the machine? See [Fallback (Python)](#fallback-python-no-npm-required).

## How it works

```
prompt / file read ──▶ tool hook ──▶ ai-guard check-* ──▶ clean ──▶ pass through
                                              │
                                              └─ credential detected (severity: block)
                                                   ──▶ BLOCKED + bypass instructions

Deliberate bypass:   npx ai-guard allow prompt --5m        (or: allow file .env --10m)
                     ──▶ allowed for N minutes (1–1440) + audit entry
```

- **Audit log** — `.ai-guard/logs/YYYY-MM-DD.jsonl`. Secrets are always masked (`sk-ant***k3Jg`); raw secrets never reach the log or stderr.
- **Extensible rules** — `.ai-guard/rules.json` with `add` (new rule; a duplicate id *replaces* the built-in), `override` (change severity), `remove`. Add your internal token format without touching code. Note: the `example-internal` demo rule (`CORP-*`) ships enabled — edit or remove it to taste.
- **Sensitive paths** — `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets/**`, and more; extend via `.ai-guard/config.json`.
- **Fail-open** — if the engine cannot run, your workflow continues (a loud warning is printed to stderr). A guard should not break your day.
- **Detection engine** — 50 built-in rules across 10 families (AWS/Google/Azure/Stripe, OpenAI/Anthropic/OpenRouter, GitHub/GitLab/Slack/npm, DB connection strings, config patterns, private keys, JWT) plus generic-assignment and Shannon-entropy heuristics (warn severity).

## Tool support matrix

| Tool | Block prompt | Block file | Notes |
|------|:---:|:---:|-------|
| Claude Code | ✅ | ✅ | UserPromptSubmit + PreToolUse (Read/Glob/Grep) |
| Codex CLI | ✅ | ✅ | PreToolUse: Edit/Write/apply_patch/MCP |
| OpenCode | ✅ | ✅ | plugin shim `.opencode/plugins/ai-guard.ts` |
| Pi | ⚠️ best-effort | ✅ | tool_call blocks natively (`{block}`); prompt side is best-effort |
| Cline | ✅ | ✅ | script hooks in `.clinerules/hooks/` (macOS/Linux; enable Features > Hooks) |
| Kiro | ⚠️ | ⚠️ | best-effort ([Kiro#7500](https://github.com/kirodotdev/Kiro/issues/7500): hook payload lacks tool_input) + steering file |
| GitHub Copilot (VS Code) | ❌ | ✅ | `.github/hooks/*.json` PreToolUse (`chat.useHooks`); the chat/prompt side cannot be blocked — platform limitation |

## Fallback (Python, no npm required)

For machines without Node. This mode registers hooks for **Claude Code + Codex only** (all 7 tools require npm):

**Easiest** — download the released fallback zip (from [releases](https://github.com/vankhangfet/ai-credential-guard/releases)), then run the installer from your project directory:

```bash
bash /path/to/fallback/install.sh          # macOS / Linux
# Windows: powershell -File install.ps1
```

**From source** (run on a machine *with* Node, once):

```bash
git clone https://github.com/vankhangfet/ai-credential-guard.git
cd ai-credential-guard
npm run build && cp dist/rules.json fallback/rules.json
# copy the fallback/ folder to the target machine, then run install.sh / install.ps1 from the project dir
```

- The Python engine lives at `.ai-guard/bin/engine.py`; block messages point to that exact path.
- **Without `rules.json` the engine degrades to warn-only heuristics (nothing is blocked)** — the installer prints a warning if the artifact is missing.
- **Uninstalling the fallback** is manual: restore `.aiguard.bak` (first-run backup) for `.claude/settings.json` and `.codex/hooks.json`, or remove the entries containing `ai-guard` by hand; delete `.ai-guard/` when you want a clean slate.

## Performance notes

- Hooks are short-lived processes. With a local install (`npm i -D ai-credential-guard`): **~0.3–0.5s per call**.
- Without a local install, the `npx` fallback can take **~6s per call on Windows** — always prefer the local install.
- `npx ai-guard uninstall --purge` **permanently deletes the audit log** without asking.

## CLI reference

| Command | Purpose |
|---------|---------|
| `init` | scaffold `.ai-guard/`, register hooks for detected tools (`--tools a,b,c` to force, `--no-instructions` to skip education files) |
| `check-prompt` | scan a prompt from stdin JSON (or raw text); exit 2 blocks it |
| `check-file <path>` | check a file path against sensitive-path rules; exit 2 blocks the read |
| `allow prompt \| file <path> --Nm` | grant a bypass for N minutes (1–1440), always audited |
| `doctor` | verify engine, rules, and every registered hook |
| `self-test` | run the built-in fixture suite against the engine |
| `uninstall [--purge]` | remove hooks (keep `.ai-guard/` by default; `--purge` deletes everything incl. audit log) |
| `version` | print the version |

## Development

```bash
npm install && npm test && npm run build
python -m unittest discover -s fallback/tests -t .   # Python fallback engine (23 tests)
```

CI runs on 3 OS × Node 20/22, plus a Python matrix and installer smoke tests (bash + PowerShell, both executing the installed engine). Releasing to npm: `npm publish` (the `prepare` script builds automatically). The fallback zip is `fallback/{engine.py,install.sh,install.ps1}` + `dist/rules.json` copied in after a build.

## License

[MIT](LICENSE)
