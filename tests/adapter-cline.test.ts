import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkproject } from "./util/mkproject";
import { clineAdapter } from "../src/adapters/cline";

// Step 0 (verified): Cline hooks do NOT use a Claude Code-style settings.json — each event is
// ONE executable script at .clinerules/hooks/<EventType> (no extension) — blog v3.36
// "cline-v3-36-hooks" + dev.to + maybedont.ai. Prompt-side DOES have UserPromptSubmit (registered too).
const HOOKS_DIR = join(".clinerules", "hooks");
const PRE = join(HOOKS_DIR, "PreToolUse");
const PROMPT = join(HOOKS_DIR, "UserPromptSubmit");

describe("cline adapter", () => {
  it("detect .cline/.clinerules dir", () => {
    expect(clineAdapter.detect(mkproject({ cline: true }))).toBe(true);
    expect(clineAdapter.detect(mkproject({}))).toBe(false);
  });
  it("install writes 2 hook scripts (PreToolUse + UserPromptSubmit) + idempotent", () => {
    const root = mkproject({ cline: true });
    expect(clineAdapter.install(root, { instructions: false }).ok).toBe(true);
    clineAdapter.install(root, { instructions: false });
    const pre = readFileSync(join(root, PRE), "utf8");
    expect(pre).toContain("ai-guard check-file");
    expect((pre.match(/ai-guard check-file/g) ?? []).length).toBe(1);
    expect(pre).toContain("cancel"); // Cline blocking contract: stdout JSON {"cancel":true,...}
    const prompt = readFileSync(join(root, PROMPT), "utf8");
    expect(prompt).toContain("ai-guard check-prompt");
    expect((prompt.match(/ai-guard check-prompt/g) ?? []).length).toBe(1);
  });
  it("install keeps user hooks on other events; does not overwrite a foreign hook in the same slot", () => {
    const root = mkproject({ cline: true });
    // user hook on another event (PostToolUse) — install must not touch it
    mkdirSync(join(root, HOOKS_DIR), { recursive: true });
    writeFileSync(join(root, HOOKS_DIR, "PostToolUse"), "#!/bin/sh\nexit 0\n");
    expect(clineAdapter.install(root, { instructions: false }).ok).toBe(true);
    expect(readFileSync(join(root, HOOKS_DIR, "PostToolUse"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    // foreign hook (no marker) occupying the PreToolUse slot -> refuse to overwrite, leave file intact
    const root2 = mkproject({ cline: true });
    mkdirSync(join(root2, HOOKS_DIR), { recursive: true });
    writeFileSync(join(root2, PRE), "#!/bin/sh\n# my own hook\nexit 0\n");
    const res = clineAdapter.install(root2, { instructions: false });
    expect(res.ok).toBe(false);
    expect(readFileSync(join(root2, PRE), "utf8")).not.toContain("ai-guard");
    expect(existsSync(join(root2, PROMPT))).toBe(false); // atomic: does not write the remaining hook
  });
  it("uninstall removes own hooks, keeps foreign hooks/other events", () => {
    const root = mkproject({ cline: true });
    clineAdapter.install(root, { instructions: false });
    writeFileSync(join(root, HOOKS_DIR, "PostToolUse"), "#!/bin/sh\nexit 0\n");
    expect(clineAdapter.uninstall(root).ok).toBe(true);
    expect(existsSync(join(root, PRE))).toBe(false);
    expect(existsSync(join(root, PROMPT))).toBe(false);
    expect(readFileSync(join(root, HOOKS_DIR, "PostToolUse"), "utf8")).toContain("exit 0");
  });
  it("doctor before/after install", () => {
    const root = mkproject({ cline: true });
    expect(clineAdapter.doctor(root).ok).toBe(false);
    clineAdapter.install(root, { instructions: false });
    expect(clineAdapter.doctor(root).ok).toBe(true);
  });
});

// Fix C (ride-along from Task 21 review): vitest EXECUTES the templates through real node to lock the cancel
// contract between template and engine. The template fast-path spawns the NEW name `node_modules/ai-credential-guard/dist/cli.js` first (old name `ai-guard` is a legacy fallback),
// so the test copies the repo's BUILT dist into a tmp project — requires `npm run build` first; if dist is missing
// (CI has not built) -> skip everything (it.skipIf).
const DIST_CLI = join(__dirname, "..", "dist", "cli.js");
const DIST_DIR = join(__dirname, "..", "dist");

describe("cline templates (executed via node — lock cancel contract)", () => {
  function mkExecProject(): string {
    const root = mkproject({ cline: true }); // .ai-guard present -> engine can block
    clineAdapter.install(root, { instructions: false });
    cpSync(DIST_DIR, join(root, "node_modules", "ai-credential-guard", "dist"), { recursive: true });
    return root;
  }
  it.skipIf(!existsSync(DIST_CLI))("PreToolUse payload .env -> stdout {\"cancel\":true}", () => {
    const root = mkExecProject();
    const payload = JSON.stringify({
      tool_name: "read_file",
      tool_input: { path: join(root, ".env") },
      workspaceRoots: [root],
    });
    const r = spawnSync(process.execPath, [join(root, PRE)], { input: payload, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0); // Cline contract: block via stdout JSON, NOT via exit code
    expect(r.stdout).toContain('"cancel":true');
    expect(r.stdout).toContain("errorMessage");
  });
  it.skipIf(!existsSync(DIST_CLI))("PreToolUse clean payload -> empty stdout, exit 0", () => {
    const root = mkExecProject();
    const payload = JSON.stringify({
      tool_name: "read_file",
      tool_input: { path: join(root, "src", "main.ts") },
      workspaceRoots: [root],
    });
    const r = spawnSync(process.execPath, [join(root, PRE)], { input: payload, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
  it.skipIf(!existsSync(DIST_CLI))("legacy fast-path: dist under the old name ai-guard still resolves (backward compat)", () => {
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
  it.skipIf(!existsSync(DIST_CLI))("UserPromptSubmit alias-miss (Fix B): secret in RAW JSON is still blocked", () => {
    const root = mkExecProject();
    // valid JSON payload but NO alias field matches (question) — the secret appears verbatim
    // in the raw JSON -> the template must fall back to scanning raw instead of skipping.
    const payload = JSON.stringify({
      clineVersion: "3.36",
      question: "dùng key AKIAIOSFODNN7EXAMPLE giúp tôi",
      workspaceRoots: [root],
    });
    const r = spawnSync(process.execPath, [join(root, PROMPT)], { input: payload, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"cancel":true');
  });
  it.skipIf(!existsSync(DIST_CLI) || process.platform !== "win32")(
    "fallback npx.cmd shell branch: bare token + quoted args (spaced path intact, injection neutralized)",
    () => {
      // Shadow npx.cmd with a stub prepended to PATH for THIS spawn only: the template's shell branch
      // calls the stub instead of real npx -> the log records EXACTLY what cmd.exe passes after parsing the
      // quoted command line (the stub running also proves the BARE command token resolves via PATH).
      const stubDir = mkdtempSync(join(tmpdir(), "aig-stub-"));
      const logFile = join(stubDir, "args.log");
      writeFileSync(join(stubDir, "npx.cmd"), '@echo off\r\n>>"%AIG_STUB_LOG%" echo %*\r\nexit /b 0\r\n');
      const env: NodeJS.ProcessEnv = { ...process.env };
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      env[pathKey] = stubDir + ";" + (env[pathKey] ?? "");
      env.AIG_STUB_LOG = logFile;

      // tmp project has NO local install under either name (skips mkExecProject) -> npx.cmd fallback.
      const root = mkproject({ cline: true });
      clineAdapter.install(root, { instructions: false });

      // 1) a path with spaces must reach the stub INTACT as ONE quoted arg
      const spaced = join(root, "my dir", "sub space", ".env");
      const r1 = spawnSync(process.execPath, [join(root, PRE)], {
        input: JSON.stringify({ tool_name: "read_file", tool_input: { path: spaced }, workspaceRoots: [root] }),
        encoding: "utf8", timeout: 60_000, cwd: root, env,
      });
      expect(r1.status).toBe(0);
      const log = readFileSync(logFile, "utf8");
      expect(log.startsWith('"--no-install" "ai-guard"')).toBe(true);
      expect(log).toContain('"--tool" "cline"');
      expect(log).toContain(`"${spaced}"`);

      // 2) injection payload: metachars (&, >) remain literal INSIDE the arg's quotes — not executed
      const pwnFile = join(root, "PWNED.txt");
      const r2 = spawnSync(process.execPath, [join(root, PRE)], {
        input: JSON.stringify({ tool_name: "read_file", tool_input: { path: `x&echo PWNED>${pwnFile}` }, workspaceRoots: [root] }),
        encoding: "utf8", timeout: 60_000, cwd: root, env,
      });
      expect(r2.status).toBe(0);
      expect(readFileSync(logFile, "utf8")).toContain('"x&echo PWNED>');
      expect(existsSync(pwnFile)).toBe(false);
    },
  );
});
