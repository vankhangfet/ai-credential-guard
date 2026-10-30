# Kiro + Copilot CLI + OpenCode Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade ai-credential-guard v1.2.0 — real Kiro tool-side blocking (IDE ≥ 1.0.116), unified Copilot (VS Code + CLI) hook file with blocking `preToolUse` + warn-only `userPromptSubmitted`, OpenCode prompt secret-stripping via parts-mutation, and fix the fast-path package-name bug in all four templates.

**Architecture:** The CLI has per-tool adapters (`src/adapters/*.ts`) that write hook/shim files from `templates/`, all funneling into two shared commands (`check-prompt`, `check-file`) that read JSON payloads on stdin. Engine-level flag/alias changes come first, then adapter changes, then templates, then docs/version.

**Tech Stack:** TypeScript (CommonJS, Node ≥ 20), vitest, npm. Spec: `docs/superpowers/specs/2026-10-29-kiro-copilot-cli-opencode-design.md`.

**Conventions:** Test helper `mkproject({kiro: true})` makes a tmp dir with `.ai-guard/` + tool dir. Tests run via `npx vitest run <file>`. Commit style: `feat:`/`fix:`/`test:`/`docs:` prefixes, end every commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: `check-prompt` — `--warn-only` flag + nested prompt aliases

**Files:**
- Modify: `src/commands/check-prompt.ts`
- Test: `tests/check-prompt.test.ts`

- [x] **Step 1: Write the failing tests**

Append inside `describe("check-prompt", ...)` in `tests/check-prompt.test.ts` (after the `payload key content` test):

```ts
  it("payload lồng data.prompt (kiro #10346 shape) -> extract + block", async () => {
    expect(
      await runCli(["check-prompt", "--root", root], JSON.stringify({ data: { prompt: "AKIAIOSFODNN7EXAMPLE" } })),
    ).toBe(2);
  });
  it("payload lồng triggerData.prompt (kiro #10346 shape) -> extract + block", async () => {
    expect(
      await runCli(["check-prompt", "--root", root], JSON.stringify({ triggerData: { prompt: "AKIAIOSFODNN7EXAMPLE" } })),
    ).toBe(2);
  });
  it("--warn-only: block findings -> vẫn exit 2 nhưng action 'warned' + stderr nêu không chặn được", async () => {
    const errSpy = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as any).write = (s: string) => { captured += s; return true; };
    let code: number;
    try {
      code = await runCli(["check-prompt", "--root", root, "--warn-only"], stdinOf(root, "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi"));
    } finally {
      (process.stderr as any).write = errSpy;
    }
    expect(code).toBe(2);
    expect(lastEvent().action).toBe("warned");
    expect(lastEvent().rule).toBe("aws-access-key");
    expect(captured).toContain("aws-access-key");
    expect(captured).toContain("cannot block");
  });
  it("--warn-only + bypass hợp lệ -> exit 0 + allowed_after_confirm (không warn spam)", async () => {
    grantBypass(root, "prompt", undefined, 5);
    const code = await runCli(["check-prompt", "--root", root, "--warn-only"], stdinOf(root, "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi"));
    expect(code).toBe(0);
    expect(lastEvent().action).toBe("allowed_after_confirm");
  });
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/check-prompt.test.ts`
Expected: FAIL — the nested-alias tests exit 0 (secret not extracted → no block); `--warn-only` tests fail on `action` being `"blocked"` and stderr missing "cannot block".

- [x] **Step 3: Implement**

In `src/commands/check-prompt.ts`:

3a. Extend the alias list in `extractPrompt` (line ~16) — add the two nested Kiro shapes after `j?.content`:

```ts
      const p = [j?.prompt, j?.input, j?.message, j?.text, j?.userPrompt, j?.content, j?.data?.prompt, j?.triggerData?.prompt].find((v) => typeof v === "string");
```

3b. In `checkPrompt`, after the `const tool = ...` line (line ~29), add:

```ts
  const warnOnly = argv.includes("--warn-only"); // boolean flag — dùng includes, KHÔNG flagValue (flagValue lấy value của flag kế tiếp)
```

3c. Replace the final block-audit + stderr section (lines ~49-59) with:

```ts
  appendAuditEvent(projectRoot, { ts: nowISO, tool, event: "prompt", action: warnOnly ? "warned" : "blocked", rule: blocks[0].ruleId, preview: blocks[0].preview, count: blocks.length });
  const lines = [
    warnOnly
      ? "ai-guard: WARNING — credential detected in prompt. This tool CANNOT block prompts (platform limit): the text may still be sent to the model."
      : "ai-guard: BLOCKED — credential detected in prompt (not sent to AI).",
    ...blocks.slice(0, 5).map((f) => `  • ${f.ruleId}: ${f.description} [preview: ${f.preview}]`),
  ];
  if (blocks.length > 5) lines.push(`  • ... and ${blocks.length - 5} more findings`);
  lines.push(
    warnOnly
      ? "To silence this warning for intentional sends, run the following then resubmit:"
      : "If you INTENTIONALLY want to send this, run the following then resubmit:",
    "  npx ai-guard allow prompt --5m",
    "(The next submission within the window will be recorded in the audit log.)",
  );
  process.stderr.write(lines.join("\n") + "\n");
  return 2;
```

Leave the `hasValidBypass` branch above untouched (bypass suppresses both modes — already covered by the new test).

- [x] **Step 4: Run the full file**

Run: `npx vitest run tests/check-prompt.test.ts`
Expected: PASS (all existing + 4 new tests).

- [x] **Step 5: Commit**

```bash
git add src/commands/check-prompt.ts tests/check-prompt.test.ts
git commit -m "feat: check-prompt --warn-only (audit 'warned', honest stderr) + nested kiro prompt aliases

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `check-file` — camelCase `toolArgs` + nested container aliases

**Files:**
- Modify: `src/commands/check-file.ts` (extractPathCandidates, lines ~17-48)
- Test: `tests/check-file.test.ts`

- [x] **Step 1: Write the failing tests**

Append a new describe block at the end of `tests/check-file.test.ts`:

```ts
describe("check-file stdin payload (copilot CLI camelCase + kiro nested shapes)", () => {
  it("payload camelCase toolArgs (copilot CLI preToolUse, object form) có filePath .env -> exit 2", async () => {
    const payload = JSON.stringify({ toolName: "read", toolArgs: { filePath: join(root, ".env") }, cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(2);
  });
  it("payload toolArgs dạng JSON string -> parse được và chặn .env", async () => {
    const payload = JSON.stringify({ toolName: "read", toolArgs: JSON.stringify({ file_path: join(root, ".env") }), cwd: root });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(2);
  });
  it("payload lồng data.file_path (kiro shape) -> exit 2", async () => {
    const payload = JSON.stringify({ data: { file_path: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, "--tool", "kiro"], payload)).toBe(2);
  });
  it("payload lồng triggerData.filePath -> exit 2", async () => {
    const payload = JSON.stringify({ triggerData: { filePath: join(root, ".env") } });
    expect(await runCli(["check-file", "--root", root, "--tool", "kiro"], payload)).toBe(2);
  });
  it("toolArgs không phải object/string JSON (số) -> bỏ qua, exit 0", async () => {
    const payload = JSON.stringify({ toolName: "bash", toolArgs: 42 });
    expect(await runCli(["check-file", "--root", root, "--tool", "copilot"], payload)).toBe(0);
  });
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/check-file.test.ts`
Expected: FAIL — first four tests exit 0 (aliases not read yet).

- [x] **Step 3: Implement**

In `src/commands/check-file.ts`, replace the direct-field lookup block (lines ~30-32):

```ts
    const ti = j?.tool_input ?? {};
    const p = [ti.file_path, ti.notebook_path, ti.path, j?.path].find((v) => typeof v === "string");
    if (typeof p === "string") return [p];
```

with:

```ts
    // Containers theo thứ tự ưu tiên: tool_input (snake/PascalCase payload — Claude/VS Code/
    // copilot PreToolUse), toolArgs (camelCase payload — copilot CLI preToolUse, kiểu
    // "unknown": object hoặc JSON string), data/triggerData (kiro session-context shapes).
    // String container được JSON.parse thử; parse fail hoặc non-object -> bỏ qua container đó.
    const containers = [j?.tool_input, j?.toolArgs, j?.data, j?.triggerData]
      .map((c) => {
        if (typeof c === "string") {
          try { return JSON.parse(c); } catch { return undefined; }
        }
        return c;
      })
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object");
    const p = containers
      .flatMap((c) => [c.file_path, c.notebook_path, c.filePath, c.path])
      .find((v) => typeof v === "string") ?? (typeof j?.path === "string" ? j.path : undefined);
    if (typeof p === "string") return [p];
```

(Keep the patch-header scan that follows unchanged — it only runs when no explicit path was found.)

- [x] **Step 4: Run the full file**

Run: `npx vitest run tests/check-file.test.ts`
Expected: PASS (existing Claude Code payload tests + 5 new tests).

- [x] **Step 5: Commit**

```bash
git add src/commands/check-file.ts tests/check-file.test.ts
git commit -m "feat: check-file reads camelCase toolArgs + nested kiro payload containers

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Copilot adapter — unified `version: 1` hook file (VS Code + CLI)

**Files:**
- Modify: `src/adapters/copilot.ts`
- Test: `tests/adapter-kiro-copilot.test.ts` (copilot describe block, lines ~108-158)

- [x] **Step 1: Update the tests**

Replace the copilot describe block's install test and doctor test in `tests/adapter-kiro-copilot.test.ts`:

```ts
  it("install tạo hook version:1 (PreToolUse chặn + userPromptSubmitted warn-only) + copilot-instructions; idempotent", () => {
    const root = mkproject({ vscode: true });
    const r = copilotAdapter.install(root, { instructions: true });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("education layer");
    expect(r.detail).toContain("warn-only");
    const hook = JSON.parse(readFileSync(join(root, COPILOT_HOOK), "utf8"));
    expect(hook.version).toBe(1);
    expect(hook.hooks.PreToolUse).toHaveLength(1);
    expect(hook.hooks.PreToolUse[0].command).toContain("check-file --tool copilot");
    expect(hook.hooks.userPromptSubmitted).toHaveLength(1);
    expect(hook.hooks.userPromptSubmitted[0].command).toContain("check-prompt --tool copilot");
    expect(hook.hooks.userPromptSubmitted[0].command).toContain("--warn-only");
    expect(readFileSync(join(root, COPILOT_INSTR), "utf8")).toContain("ai-guard:start");
    copilotAdapter.install(root, { instructions: true });
    expect(JSON.parse(readFileSync(join(root, COPILOT_HOOK), "utf8")).hooks.PreToolUse).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, COPILOT_HOOK), "utf8")).hooks.userPromptSubmitted).toHaveLength(1);
    expect((readFileSync(join(root, COPILOT_INSTR), "utf8").match(/ai-guard:start/g) ?? []).length).toBe(1);
  });
```

Replace the doctor test with:

```ts
  it("doctor: thiếu -> not ok; sau install -> ok + nêu warn-only không chặn được prompt", () => {
    const root = mkproject({ vscode: true });
    expect(copilotAdapter.doctor(root).ok).toBe(false);
    copilotAdapter.install(root, { instructions: true });
    const d = copilotAdapter.doctor(root);
    expect(d.ok).toBe(true);
    expect(d.detail).toContain("education layer");
    expect(d.detail).toContain("cannot block");
    expect(d.detail).toContain("warn");
  });
  it("doctor: hook file legacy (không version:1, không prompt entry) -> not ok, re-install sửa", () => {
    const root = mkproject({ vscode: true });
    mkdirSync(join(root, ".github", "hooks"), { recursive: true });
    // format <=1.1.x: chỉ PreToolUse, không có "version"
    writeFileSync(join(root, COPILOT_HOOK), JSON.stringify(
      { hooks: { PreToolUse: [{ type: "command", command: "npx --no-install ai-guard check-file --tool copilot" }] } },
      null,
      2,
    ));
    const d = copilotAdapter.doctor(root);
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("re-run install");
    copilotAdapter.install(root, { instructions: false });
    expect(copilotAdapter.doctor(root).ok).toBe(true);
  });
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/adapter-kiro-copilot.test.ts`
Expected: FAIL — install test fails on `hook.version` / `userPromptSubmitted`; new doctor-legacy test fails (old doctor returns ok=true on legacy file).

- [x] **Step 3: Implement**

In `src/adapters/copilot.ts`:

3a. Replace the header comment block (lines ~7-16) with:

```ts
// GitHub Copilot (VS Code + CLI) — education layer chính + unified hook file.
// Step 0 verified (docs.github.com/en/copilot/reference/hooks-reference, Oct 2026):
// Copilot CLI + VS Code đọc repo-level `.github/hooks/*.json` dạng { "version": 1, hooks }
// — event PascalCase (PreToolUse) dùng Claude matcher semantics + payload snake_case
// (tool_name/tool_input — extractor check-file đã parse), exit 2 = DENY trên CLI
// (fail-closed; chỉ timeout fail-open), blocking error trên VS Code agent mode.
// GIỚI HẠN (platform, docs reference): userPromptSubmitted KHÔNG chặn được — exit 2 chỉ
// surface stderr như warning, prompt vẫn tới model (check-prompt --warn-only: audit
// 'warned' + stderr warning). Education layer (.github/copilot-instructions.md) vẫn là
// lớp prompt chính.
```

3b. Replace `HOOK_BODY` (lines ~24-35) with:

```ts
// Unified format: "version": 1 required bởi Copilot CLI; VS Code đọc cùng file.
// PreToolUse (PascalCase) -> payload tool_name/tool_input (đã parse), exit 2 = deny/block.
// userPromptSubmitted (camelCase CLI event) -> warn-only (platform không cho block).
const HOOK_BODY =
  JSON.stringify(
    {
      version: 1,
      hooks: {
        PreToolUse: [
          { type: "command", command: "npx --no-install ai-guard check-file --tool copilot", timeoutSec: 30 }, // npx fallback ~6-10s lần đầu — 30s headroom, docs default 30
        ],
        userPromptSubmitted: [
          { type: "command", command: "npx --no-install ai-guard check-prompt --tool copilot --warn-only", timeoutSec: 30 },
        ],
      },
    },
    null,
    2,
  ) + "\n";
```

3c. In `install`, update the success `detail` (line ~71) to:

```ts
        detail: REGISTER_HOOK
          ? `hook PreToolUse + userPromptSubmitted warn-only (${HOOK_REL}, VS Code agent mode + Copilot CLI) + education layer ${INSTR_REL} — prompts cannot be blocked (platform limit), instructions are the primary prompt layer`
          : `education layer ${INSTR_REL} — prompt side cannot be blocked (platform limitation)`,
```

3d. Replace `doctor` (lines ~110-123) with:

```ts
  doctor(root: string) {
    const instrPath = join(root, INSTR_REL);
    const hookPath = join(root, HOOK_REL);
    const hasInstr = existsSync(instrPath) && readFileSync(instrPath, "utf8").includes(SECTION_MARKER);
    let hookOk = false;
    let hookDetail: string;
    if (!existsSync(hookPath)) {
      hookDetail = "no hook";
    } else if (!readFileSync(hookPath, "utf8").includes(MARKER)) {
      hookDetail = "hook file does not belong to ai-guard";
    } else {
      let version: unknown;
      let entries: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(readFileSync(hookPath, "utf8"));
        version = parsed?.version;
        if (parsed?.hooks && typeof parsed.hooks === "object") entries = parsed.hooks;
      } catch { /* JSON hỏng -> entries rỗng -> outdated */ }
      const hasEntry = (event: string, cmdPart: string) =>
        Array.isArray(entries[event]) &&
        (entries[event] as Array<{ command?: unknown }>).some(
          (h) => typeof h?.command === "string" && h.command.includes(cmdPart),
        );
      const blocking = hasEntry("PreToolUse", "check-file --tool copilot");
      const warnOnly = hasEntry("userPromptSubmitted", "check-prompt --tool copilot");
      if (version === 1 && blocking && warnOnly) {
        hookOk = true;
        hookDetail = "hooks installed (PreToolUse blocks file reads; userPromptSubmitted warns — prompts cannot be blocked, platform limit)";
      } else {
        const missing = [
          version !== 1 && '"version": 1',
          !blocking && "PreToolUse (check-file)",
          !warnOnly && "userPromptSubmitted (check-prompt, warn-only)",
        ].filter(Boolean).join(" + ");
        hookDetail = `hook outdated — missing ${missing}; re-run install`;
      }
    }
    const ok = hasInstr && (!REGISTER_HOOK || hookOk);
    return {
      ok,
      detail: hasInstr
        ? `education layer ${INSTR_REL} installed (${hookDetail})`
        : `missing education layer ${INSTR_REL} (${hookDetail})`,
    };
  },
```

3e. Change the adapter `label` (line ~39) to `"GitHub Copilot (VS Code + CLI)"`.

- [x] **Step 4: Run the full file**

Run: `npx vitest run tests/adapter-kiro-copilot.test.ts`
Expected: PASS — kiro block unchanged, copilot block green (install/idempotent/no-instructions/uninstall/doctor/doctor-legacy).

- [x] **Step 5: Commit**

```bash
git add src/adapters/copilot.ts tests/adapter-kiro-copilot.test.ts
git commit -m "feat: copilot adapter — unified version:1 hook file (VS Code + CLI), blocking preToolUse + warn-only prompt hook

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Kiro adapter — tool-side capability upgrade messaging

**Files:**
- Modify: `src/adapters/kiro.ts`
- Test: `tests/adapter-kiro-copilot.test.ts` (kiro describe block, lines ~23-106)

- [x] **Step 1: Update the tests**

In `tests/adapter-kiro-copilot.test.ts`, kiro describe block:

1a. In the install test (line ~28), replace `expect(r.detail).toContain("best-effort");` with:

```ts
    expect(r.detail).toContain("1.0.116");
```

1b. In the doctor test (line ~72), replace:

```ts
    expect(before.detail).toContain("best-effort");
```

with:

```ts
    expect(before.detail).toContain("1.0.116");
```

and replace:

```ts
    expect(after.detail).toContain("best-effort");
    expect(after.detail).toContain("kirodotdev/Kiro#7500");
```

with:

```ts
    expect(after.detail).toContain("1.0.116");
    expect(after.detail).toContain("kirodotdev/Kiro#7500");
```

1c. Update the describe title (line 23) to `"kiro adapter (prompt-blocking hook + tool-blocking hook (IDE >= 1.0.116) + steering education)"`.

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/adapter-kiro-copilot.test.ts`
Expected: FAIL — detail strings still say "best-effort".

- [x] **Step 3: Implement**

In `src/adapters/kiro.ts`:

3a. Replace the header comment lines 15-19 (the `GIỚI HẠN ĐÃ XÁC NHẬN` paragraph) with:

```ts
// ĐÃ FIX UPSTREAM (github.com/kirodotdev/Kiro#7500): resolved ở Kiro IDE v1.0.116
// (Jul 2026) — PreToolUse command hooks NHẬN tool payload (stdin có tool context),
// exit 2 chặn tool call. IDE cũ hơn (< 1.0.116) truyền stdin rỗng -> check-file
// không thấy path -> exit 0 (fail-open). Prompt-side: regression #10346 (UserPromptSubmit
// nhận prompt rỗng ở 1.0.138–1.0.242) fixed ở 1.0.293 — khuyên dùng IDE >= 1.0.293.
```

3b. Replace `TOOL_BEST_EFFORT` (line 51) with:

```ts
// Tool side chặn THẬT trên IDE >= 1.0.116 (#7500 fixed); IDE cũ fail-open (stdin rỗng).
const TOOL_SIDE_NOTE = "tool-side blocking works on IDE >= 1.0.116 (kirodotdev/Kiro#7500 fixed); older IDEs pass an empty payload (fail-open)";
```

3c. Replace all three `TOOL_BEST_EFFORT` usages with `TOOL_SIDE_NOTE`:
- install detail (line ~85): `` `hooks UserPromptSubmit (prompt, user-verified) + PreToolUse (${TOOL_BEST_EFFORT}) at ${HOOK_REL} + education layer ${STEERING_REL}` `` → same string with `TOOL_SIDE_NOTE`
- doctor missing-hook detail (line ~113) and outdated detail (line ~142) and ok detail (line ~146): swap `TOOL_BEST_EFFORT` → `TOOL_SIDE_NOTE`

3d. In `HOOK_BODY`, update the PreToolUse entry's `description` (line ~39) to:

```ts
          description: "ai-guard: block credential file reads — exit 2 blocks the tool call (IDE >= 1.0.116; older IDEs fail open, see kirodotdev/Kiro#7500)",
```

- [x] **Step 4: Run the full file**

Run: `npx vitest run tests/adapter-kiro-copilot.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/adapters/kiro.ts tests/adapter-kiro-copilot.test.ts
git commit -m "feat: kiro tool-side PreToolUse upgraded to real blocking (IDE >= 1.0.116, #7500 fixed)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: OpenCode shim — parts-mutation prompt blocking + fast-path fix

**Files:**
- Modify: `templates/opencode-shim.ts`
- Test: `tests/adapter-opencode.test.ts`

- [x] **Step 1: Write the failing tests**

Replace the first install test in `tests/adapter-opencode.test.ts` (lines ~12-19) with:

```ts
  it("install tạo shim plugin chứa marker + spawn check-file/check-prompt + fast-path đúng tên package + parts-mutation, idempotent", () => {
    const root = mkproject({ opencode: true });
    expect(opencodeAdapter.install(root, { instructions: false }).ok).toBe(true);
    opencodeAdapter.install(root, { instructions: false });
    const shim = readFileSync(join(root, ".opencode", "plugins", "ai-guard.ts"), "utf8");
    expect(shim).toContain("ai-guard check-file");
    expect(shim).toContain("ai-guard check-prompt");
    // fast-path: package tên ai-credential-guard (bug <=1.1.0 check sai node_modules/ai-guard)
    expect(shim).toContain("node_modules/ai-credential-guard/dist/cli.js");
    // prompt-side: parts-mutation (chat.message throw bị silently caught — anomalyco/opencode#30434)
    expect(shim).toContain("output.parts");
    expect(shim).toContain("opencode#30434");
  });
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/adapter-opencode.test.ts`
Expected: FAIL on the two new assertions (template still checks `node_modules/ai-guard` and has no parts-mutation).

- [x] **Step 3: Implement**

In `templates/opencode-shim.ts`:

3a. Replace `resolveCmd` (lines ~16-23) with:

```ts
// Fast-path: package npm tên `ai-credential-guard` (bin `ai-guard`). Bug <=1.1.0: chỉ check
// `node_modules/ai-guard/...` (tên CŨ) -> local install không bao giờ match, mọi check trả
// npx ~6s/call (Windows). Fix: check tên MỚI trước (project + parent), giữ tên cũ làm
// legacy fallback cho install từ trước lúc rename. Fallback npx chỉ khi không có local
// install: win32 spawn không tìm được `npx` (batch script) khi tách args -> phải dùng
// npx.cmd + shell:true (guard() quote sẵn args — xem dưới); posix giữ bare npx.
function resolveCmd(): { cmd: string; prefix: string[] } {
  for (const p of [
    "node_modules/ai-credential-guard/dist/cli.js",
    "../node_modules/ai-credential-guard/dist/cli.js",
    "node_modules/ai-guard/dist/cli.js",
    "../node_modules/ai-guard/dist/cli.js",
  ]) {
    if (existsSync(p)) return { cmd: process.execPath, prefix: [p] };
  }
  return process.platform === "win32"
    ? { cmd: "npx.cmd", prefix: ["--no-install", "ai-guard"] }
    : { cmd: "npx", prefix: ["--no-install", "ai-guard"] };
}
```

3b. Replace the `chat.message` hook (lines ~82-90) with:

```ts
  // Fires when a new (user) message is received. Extract text parts from output.parts.
  // HẠNG MỎNG: throw trong chat.message bị OpenCode silently catch (anomalyco/opencode#30434,
  // closed not-planned) — KHÔNG chặn được message. Giải pháp thật (community-confirmed):
  // mutate output.parts in place — thay text của MỌI text part bằng block notice -> secret
  // KHÔNG bao giờ tới model (model nhận notice thay vì credential). Fail-open: nếu shape
  // parts đổi (không còn mảng text parts) thì chỉ log, message đi qua như cũ.
  "chat.message": async (_input: any, output: any) => {
    const parts: any[] = Array.isArray(output?.parts) ? output.parts : [];
    const text: string = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
    if (!text.trim()) return;
    try {
      guard(["check-prompt", "--tool", "opencode"], text);
    } catch (blocked) {
      const notice =
        "ai-guard: BLOCKED — credential detected in prompt; text replaced before reaching the model. " +
        String((blocked as Error)?.message ?? "");
      for (const p of parts) {
        if (p?.type === "text") p.text = notice;
      }
      console.error(notice);
    }
  },
```

3c. Update the file header comment (lines 1-6) — replace the `chat.message` bullet:

```ts
//   chat.message: (input: { sessionID, ... }, output: { message: UserMessage, parts: Part[] }) —
//     UserMessage has NO nested parts; text lives in sibling output.parts[] as { type: "text", text }.
//     Throw KHÔNG chặn được (silently caught — anomalyco/opencode#30434): block = mutate
//     output.parts in place (text parts -> block notice) để secret không tới model.
```

- [x] **Step 4: Run the full file**

Run: `npx vitest run tests/adapter-opencode.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add templates/opencode-shim.ts tests/adapter-opencode.test.ts
git commit -m "feat: opencode prompt-side secret-stripping via parts-mutation (#30434) + fix fast-path package name

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Pi shim + Cline templates — same fast-path fix

**Files:**
- Modify: `templates/pi-shim.ts` (resolveCmd, ~line 22)
- Modify: `templates/cline-hook-pretooluse.js` (resolveCmd, ~lines 19-31)
- Modify: `templates/cline-hook-userpromptsubmit.js` (same resolveCmd block)
- Test: `tests/adapter-pi.test.ts`, `tests/adapter-cline.test.ts`

- [x] **Step 1: Write the failing tests**

1a. In `tests/adapter-pi.test.ts`, extend the install test's shim assertions (after `expect(shim).toContain("resolveCmd");`):

```ts
    // fast-path: package tên ai-credential-guard (bug <=1.1.0 check sai node_modules/ai-guard)
    expect(shim).toContain("node_modules/ai-credential-guard/dist/cli.js");
```

1b. In `tests/adapter-cline.test.ts`, in the exec describe block, change `mkExecProject` to install the dist under the NEW package name (fast-path now resolves it there):

```ts
  function mkExecProject(): string {
    const root = mkproject({ cline: true }); // .ai-guard sẵn -> engine chặn được
    clineAdapter.install(root, { instructions: false });
    cpSync(DIST_DIR, join(root, "node_modules", "ai-credential-guard", "dist"), { recursive: true });
    return root;
  }
```

and add a legacy-path test right after the existing PreToolUse tests:

```ts
  it.skipIf(!existsSync(DIST_CLI))("fast-path legacy: dist dưới tên cũ ai-guard vẫn resolve (backward compat)", () => {
    const root = mkproject({ cline: true });
    clineAdapter.install(root, { instructions: false });
    cpSync(DIST_DIR, join(root, "node_modules", "ai-guard", "dist"), { recursive: true });
    const payload = JSON.stringify({
      tool_name: "read_file",
      tool_input: { path: join(root, ".env") },
      workspaceRoots: [root],
    });
    const r = spawnSync(process.execPath, [join(root, PRE)], { input: payload, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"cancel":true');
  });
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/adapter-pi.test.ts tests/adapter-cline.test.ts`
Expected: pi FAIL on new assertion; cline exec tests FAIL (fast-path can't find dist at the new path — requires `npm run build` first; if dist is missing they skip — run `npm run build` then re-run).

- [x] **Step 3: Implement**

3a. `templates/pi-shim.ts` — replace the path list in `resolveCmd` (the `for (const p of [...])` block) with the same 4-entry list as Task 5 (new name project/parent first, then legacy name project/parent).

3b. `templates/cline-hook-pretooluse.js` — replace the whole `resolveCmd` function (keep the explanatory comment above it, updated as shown):

```js
// Fast-path: package npm tên `ai-credential-guard` (bin `ai-guard`). Bug <=1.1.0: chỉ check
// `node_modules/ai-guard/...` (tên CŨ) -> local install không match, mọi check trả npx ~6s.
// Fix: check tên MỚI trước (mỗi base: project + parent), giữ tên cũ làm legacy fallback.
function resolveCmd() {
  for (const base of [join(__dirname, "..", ".."), process.cwd()]) {
    for (const name of ["ai-credential-guard", "ai-guard"]) {
      for (const rel of [join("node_modules", name, "dist", "cli.js"), join("..", "node_modules", name, "dist", "cli.js")]) {
        const p = join(base, rel);
        if (existsSync(p)) return { cmd: process.execPath, prefix: [p] };
      }
    }
  }
  return process.platform === "win32"
    ? { cmd: "npx.cmd", prefix: ["--no-install", "ai-guard"] }
    : { cmd: "npx", prefix: ["--no-install", "ai-guard"] };
}
```

3c. Apply the identical `resolveCmd` replacement in `templates/cline-hook-userpromptsubmit.js`.

- [x] **Step 4: Run the full files**

Run: `npm run build && npx vitest run tests/adapter-pi.test.ts tests/adapter-cline.test.ts`
Expected: PASS (cline exec tests now resolve dist via the new package path; legacy test passes; npx-fallback test unaffected — its project has no node_modules at all).

- [x] **Step 5: Commit**

```bash
git add templates/pi-shim.ts templates/cline-hook-pretooluse.js templates/cline-hook-userpromptsubmit.js tests/adapter-pi.test.ts tests/adapter-cline.test.ts
git commit -m "fix: fast-path resolves ai-credential-guard package name (pi shim, cline templates)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: README + version 1.2.0

**Files:**
- Modify: `README.md`
- Modify: `package.json` (version)
- Modify: `src/cli.ts:10` (version string)
- Modify: `package-lock.json` (via npm)

- [x] **Step 1: Update README**

1a. Supported tools table — replace the Kiro row:

```markdown
| Kiro | ✅ | ✅ | tool-side needs IDE ≥ 1.0.116 ([#7500](https://github.com/kirodotdev/Kiro/issues/7500) fixed); use ≥ 1.0.293 ([#10346](https://github.com/kirodotdev/Kiro/issues/10346) prompt regression fixed) |
```

1b. Replace the Copilot row:

```markdown
| GitHub Copilot (VS Code + CLI) | ⚠️ | ✅ | prompts: warn-only — Copilot hooks cannot block a submitted prompt (platform limit); file reads blocked via `.github/hooks` (`version: 1`); VS Code agent mode needs `chat.useHooks` |
```

1c. In the *Configuration* section's audit-log table row, after `review the audit log — secrets are always masked (e.g. `sk-ant***k3Jg`)`, append: `. Actions: `blocked`, `warned` (heuristic or warn-only prompt — detected, not blocked), `allowed_after_confirm``.

- [x] **Step 2: Bump version**

In `package.json` change `"version": "1.1.0"` → `"version": "1.2.0"`.
In `src/cli.ts` line 10 change `console.log("ai-guard 1.1.0");` → `console.log("ai-guard 1.2.0");`
Run: `npm install --package-lock-only` (refreshes lockfile version fields).

- [x] **Step 3: Verify**

Run: `npx vitest run` then `npm run build && node dist/cli.js version`
Expected: full suite PASS; build succeeds; prints `ai-guard 1.2.0`.

- [x] **Step 4: Commit**

```bash
git add README.md package.json package-lock.json src/cli.ts
git commit -m "docs+chore: v1.2.0 — readme capability table (kiro tool-side, copilot CLI warn-only), audit actions

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Final verification

- [x] **Step 1: Full suite + build + smoke**

Run: `npm test && npm run build && node dist/cli.js self-test && node dist/cli.js version`
Expected: all tests PASS, build OK, self-test 0 failures, version `1.2.0`.

- [x] **Step 2: Smoke the new engine behavior end-to-end**

```bash
cd "$(mktemp -d)" && mkdir .ai-guard && echo '{"add":[],"override":{},"remove":[]}' > .ai-guard/rules.json
echo '{"prompt":"use AKIAIOSFODNN7EXAMPLE please","tool":"copilot"}' | node <repo>/dist/cli.js check-prompt --warn-only --tool copilot; echo "exit=$?"
```

Expected: stderr shows the `cannot block` warning, `exit=2`.

- [x] **Step 3: Report hand-verification drill to user**

Remind the user of the four hand-verification steps from the spec (Kiro ≥ 1.0.293 prompt+file, Copilot CLI file-denial + prompt-warning, VS Code Copilot file-block incl. `version: 1` acceptance, OpenCode prompt-strip + file-block) — release (`npm publish`) only after their sign-off.

---

## Self-Review

- **Spec coverage**: §1 copilot (Task 3), §2 kiro (Task 4), §3 opencode + fast-path (Tasks 5-6), §4 extractors (Tasks 1-2), §5 tests (inline in every task), §6 docs/version (Task 7), verification plan (Task 8). Contingency (VS Code rejects `version: 1`) is spec-level — triggered only by hand-verification failure.
- **Placeholders**: none — every step carries full code/commands.
- **Type consistency**: `TOOL_SIDE_NOTE` used in all three sites (Task 4); `resolveCmd` path list identical in opencode/pi (4-entry) and cline (loop form, same 4 resolutions); `--warn-only` parsed with `argv.includes` only in `check-prompt` (never passed to `check-file`, so its flag-value positional filter is unaffected).
