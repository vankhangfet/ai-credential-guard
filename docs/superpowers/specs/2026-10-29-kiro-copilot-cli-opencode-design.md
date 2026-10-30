# Design: Kiro + GitHub Copilot CLI + OpenCode improvements

Date: 2026-10-29
Status: approved (user-approved design 2026-10-29)
Target version: 1.2.0

## Background

`ai-credential-guard` ships adapters that register blocking hooks per AI tool. Three
tools had gaps that upstream platform changes have since closed or reshaped:

- **Kiro**: the adapter's tool-side `PreToolUse` hook was labeled best-effort because
  the IDE passed an empty stdin payload ([kirodotdev/Kiro#7500](https://github.com/kirodotdev/Kiro/issues/7500)).
  That bug is fixed in Kiro IDE **v1.0.116** (Jul 2026, community-verified; issue still
  open but fix confirmed in-thread). A later regression (empty prompt on
  `UserPromptSubmit`, [#10346](https://github.com/kirodotdev/Kiro/issues/10346))
  affected IDE 1.0.138–1.0.242 and was fixed in **v1.0.293** (Aug 2026).
- **GitHub Copilot CLI** now has a full hooks system
  ([reference](https://docs.github.com/en/copilot/reference/hooks-reference)):
  repo-level `.github/hooks/*.json` files with `"version": 1`. `preToolUse` (and
  PascalCase `PreToolUse`) can **deny** tool calls (exit 2, fail-closed on errors;
  only timeouts fail open). `userPromptSubmitted` **cannot block** — exit 2 only
  surfaces stderr as a warning and the prompt still reaches the model; stdout output
  from command hooks is dropped.
- **OpenCode**: `tool.execute.before` throw-to-block is officially documented
  ([plugins docs](https://opencode.ai/docs/plugins)). `chat.message` **cannot block
  by throwing** — errors are silently caught; the feature request was closed
  not-planned ([anomalyco/opencode#30434](https://github.com/anomalyco/opencode/issues/30434)).
  The community-confirmed workaround is mutating `output.parts` in place, which
  replaces the message content before it reaches the LLM.

Bug found during research (fixed as part of this work): all four template fast-paths
(`opencode-shim.ts`, `pi-shim.ts`, `cline-hook-pretooluse.js`,
`cline-hook-userpromptsubmit.js`) check `node_modules/ai-guard/dist/cli.js`, but the
published package is `ai-credential-guard`. The fast-path never matches a normal
local install, so every check falls back to `npx` (~6 s per call on Windows vs
~300 ms via `process.execPath`). The `npx` fallback itself works because the bin
name is `ai-guard`.

## User decisions (2026-10-29)

1. Copilot prompt side: register the warn-only `userPromptSubmitted` hook
   (visible warning + audit trail, clearly labeled non-blocking).
2. OpenCode prompt side: implement secret-stripping via `output.parts` mutation.
3. Verification: the user hand-verifies all three tools on real installs before
   release (same drill used for the original Kiro UserPromptSubmit verification).
4. Approach A chosen: extend existing adapters in place; one unified Copilot hook
   file; fix the fast-path bug across all templates.

## 1. Copilot adapter — "GitHub Copilot (VS Code + CLI)"

Migrate `.github/hooks/ai-guard.json` to the unified format (one file, both surfaces):

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "npx --no-install ai-guard check-file --tool copilot", "timeoutSec": 30 }
    ],
    "userPromptSubmitted": [
      { "type": "command", "command": "npx --no-install ai-guard check-prompt --tool copilot --warn-only", "timeoutSec": 30 }
    ]
  }
}
```

- PascalCase `PreToolUse` → Claude matcher semantics, `tool_name`/`tool_input`
  payload (already parsed by `check-file`); exit 2 = deny on Copilot CLI
  (fail-closed); on VS Code it is the blocking error path verified at Step 0.
- `userPromptSubmitted` → warn-only: exit 2 surfaces stderr to the user; the prompt
  still proceeds (platform limit, labeled as such everywhere it appears).
- New `--warn-only` flag on `check-prompt`:
  - audit action `"warned"` (instead of `"blocked"` — no false telemetry),
  - stderr message states the secret may still be sent to the model,
  - still exits 2 (that is what surfaces stderr), bypass windows still honored,
  - older engines ignore the unknown flag (argv parser skips unknown `--flags`
  when collecting positionals) → backward compatible.
- Doctor: hook file must contain the marker, `"version": 1`, a `PreToolUse` entry
  with `check-file --tool copilot`, and a `userPromptSubmitted` entry with
  `check-prompt --tool copilot`. Legacy files (no version / no prompt entry) are
  reported outdated → re-run install (install stays idempotent, marker-guarded).
- Detection unchanged: `.vscode` directory, or explicit `--tools copilot`.
  Copilot CLI has no project-level marker; users opt in via `--tools copilot`.
- Label: `GitHub Copilot (VS Code + CLI)`.
- **Contingency** (only if hand-verification shows VS Code rejects `version: 1`
  files): split into two files — legacy format for VS Code, `version: 1` for CLI —
  in separate files under `.github/hooks/`.

## 2. Kiro adapter — capability upgrade, no format change

The existing `.kiro/hooks/ai-guard.json` (version `"v1"`, PascalCase triggers,
`hooks[]` array with `name`/`trigger`/`action`) already matches the IDE 1.0 /
CLI V3 format. No file-format change.

- Tool-side `PreToolUse` messaging: "best-effort" → **real blocking on IDE
  ≥ v1.0.116** (#7500 fixed); older IDEs pass an empty payload → `check-file`
  exits 0 (fail-open), which stays the documented behavior for old versions.
- Prompt-side note: regression window 1.0.138–1.0.242 (#10346) → recommend
  IDE ≥ 1.0.293.
- `install`/`uninstall`/`doctor` detail strings updated; README table Kiro row
  becomes ✅ prompts / ✅ file reads (was ⚠️ on reads) with the version note.

## 3. OpenCode — real prompt-side protection + speed fix

In `templates/opencode-shim.ts`:

- **`chat.message`**: on exit 2, do **not** throw (silently caught upstream —
  a no-op). Instead mutate `output.parts` in place: every string text part's
  `text` is replaced with a GENERIC block notice (no secret previews — even
  masked fragments must not reach the model — and no bypass command, so an
  agent cannot self-serve the unlock from model-visible text), so the secret
  never reaches the LLM. `console.error` prints the full engine message
  (masked previews + bypass instructions) for the human. `guard()` tags its
  throw with `.blocked = true`; the catch mutates only on a real block — any
  other throw logs and fails open (message passes through, warning printed).
- **Fast-path fix**: `resolveCmd` checks the published package name
  `ai-credential-guard` before the legacy `ai-guard` (both at plugin-dir and
  cwd bases; plugin-dir via `import.meta.dir` is cwd-independent), and only
  uses `process.execPath` when its basename is a JS runtime (node|bun|deno) —
  OpenCode ships as a Bun compiled executable where `process.execPath` points
  at the OpenCode binary itself (spawning it with cli.js would silently
  fail-open); in that case try `Bun.which("node"|"bun")`, else `npx` fallback.
- `tool.execute.before` unchanged (officially documented throw-to-block).

The same fast-path fix (new package path first, legacy path kept) is applied to
`templates/pi-shim.ts` and both Cline hook templates — identical bug, identical fix.

## 4. Shared extractor hardening (defensive, cheap)

- `extractPrompt` (`src/commands/check-prompt.ts`): add nested aliases
  `j.data.prompt` / `j.triggerData.prompt` (Kiro #10346 shapes) to the existing
  alias list, before the raw-text fallback.
- `extractPathCandidates` (`src/commands/check-file.ts`): in addition to
  `tool_input`, check camelCase `toolArgs` (object or JSON string) and nested
  `data` / `triggerData` containers (keys read directly under each container);
  path keys gain `filePath` alongside the existing `file_path`/`notebook_path`/
  `path` (a bare `file` key is deliberately NOT added — too generic,
  false-positive-prone). First match wins; ordering and existing semantics
  (argv positional wins; patch-header scan last) unchanged.

## 5. Tests

- `tests/adapter-kiro-copilot.test.ts`: copilot hook body has `version: 1`,
  both entries, correct commands; doctor accepts the new file, flags legacy
  (no-version / prompt-entry-missing) files as outdated; kiro doctor wording
  reflects the upgraded capability.
- `tests/adapter-opencode.test.ts`: installed shim contains the
  `ai-credential-guard` fast-path and the parts-mutation block; plus functional
  tests (skipIf dist missing, cline-precedent) executing the real template:
  secret prompt mutates all text parts (secret absent, no throw), clean prompt
  passes through, `.env` tool call throws.
- `tests/adapter-cline.test.ts` / `tests/adapter-pi.test.ts`: fast-path tests
  create `node_modules/ai-credential-guard/dist/cli.js` (and one legacy-path
  case) instead of `node_modules/ai-guard/...`.
- `tests/check-prompt.test.ts`: `--warn-only` (audit action `warned`, adjusted
  stderr, exit 2, bypass honored); nested `data.prompt`/`triggerData.prompt`.
- `tests/check-file.test.ts`: camelCase `toolArgs` (object and JSON-string
  forms), nested `data.tool_input`-style payloads, `filePath` key.

## 6. Documentation and release

- README: support table (Kiro ✅/✅ with "IDE ≥ 1.0.116 / ≥ 1.0.293" notes;
  Copilot row renamed "GitHub Copilot (VS Code + CLI)" with prompts ⚠️
  warn-only / file reads ✅); audit log section documents the `warned` action;
  platform-limit notes updated with current issue links.
- Version bump to **1.2.0** (bundles these features and the npm metadata
  changes: repository/homepage/bugs/keywords + README links).
- Python fallback is out of scope (covers Claude Code and Codex only).

## Verification plan (user hand-verifies before release)

1. **Kiro ≥ 1.0.293**: prompt containing a fake credential is blocked;
   agent attempt to read `.env` is blocked (tool-side, IDE ≥ 1.0.116).
2. **Copilot CLI**: agent attempt to read `.env` is denied; prompt containing a
   fake credential shows the ai-guard warning and proceeds (warn-only).
3. **VS Code Copilot**: agent attempt to read `.env` is blocked — confirms
   VS Code accepts the `version: 1` hook file (else contingency above).
4. **OpenCode**: prompt containing a fake credential → model receives the block
   notice (secret stripped); agent attempt to read `.env` → tool error.

## Error handling

All new paths preserve fail-open semantics:

- parts-mutation wrapped in try/catch (shape change → today's behavior);
- extractor alias misses → existing raw-scan fallback;
- `--warn-only` unknown to older engines → current behavior (flag ignored);
- Copilot CLI `preToolUse` is fail-closed by the platform itself (errors deny);
  timeouts fail open — documented platform behavior, no code needed.
