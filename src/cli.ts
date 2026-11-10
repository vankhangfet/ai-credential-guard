#!/usr/bin/env node
// Shebang REQUIRED: npm only generates shims (.cmd/.ps1/sh) that call `node <bin>` when the bin file has a shebang.
// Without it, the Windows shim runs cli.js directly (silently exits 0 — the hook never runs),
// while the POSIX shim execs the raw file → sh parses JS → exit 2 (blocks every prompt).

export async function runCli(argv: string[], input: string): Promise<number> {
  try {
    return await dispatchCommand(argv, input);
  } catch (e) {
    return handleInternalError(argv, e);
  }
}

// Unexpected crash inside a command: record it in the audit log and on stderr. Hook commands (check-prompt /
// check-file) fail OPEN (exit 0) so a guard bug never blocks the user's workflow; other commands exit 1.
async function handleInternalError(argv: string[], e: unknown): Promise<number> {
  const command = argv[0] ?? "";
  try {
    const [{ findProjectRoot }, { logInternalError, sanitizeErrorMessage }, { flagValue }] = await Promise.all([
      import("./root"), import("./audit/log"), import("./util/argv"),
    ]);
    const root = findProjectRoot(flagValue(argv, "--root") ?? process.cwd());
    if (root) logInternalError(root, flagValue(argv, "--tool") ?? "unknown", command, e);
    const msg = sanitizeErrorMessage((e as { message?: string })?.message ?? String(e));
    process.stderr.write(
      STDIN_COMMANDS.has(command)
        ? `ai-guard: internal error in ${command} (${msg}) — check SKIPPED (fail-open). Details: .ai-guard/logs/\n`
        : `ai-guard: internal error in ${command} (${msg}). Details: .ai-guard/logs/\n`,
    );
  } catch { /* reporting must never throw */ }
  return STDIN_COMMANDS.has(command) ? 0 : 1;
}

async function dispatchCommand(argv: string[], input: string): Promise<number> {
  const command = argv[0];
  switch (command) {
    case "version":
      // read from package.json so the printed version can never drift from the published one
      console.log(`ai-guard ${require("../package.json").version}`);
      return 0;
    case "check-prompt":
      return (await import("./commands/check-prompt")).checkPrompt(argv.slice(1), input);
    case "check-file":
      return (await import("./commands/check-file")).checkFile(argv.slice(1), input);
    case "allow":
      return (await import("./commands/allow")).allow(argv.slice(1));
    case "init":
      return (await import("./commands/init")).init(argv.slice(1), input);
    case "doctor":
      return (await import("./commands/doctor")).doctor(argv.slice(1));
    case "uninstall":
      return (await import("./commands/uninstall")).uninstall(argv.slice(1));
    case "self-test": {
      const { selfTest, printSelfTest } = await import("./commands/self-test");
      const r = selfTest();
      printSelfTest(r);
      return r.failures.length ? 1 : 0;
    }
    default:
      console.error(
        "ai-guard: unknown or missing command. usage: ai-guard <init|check-prompt|check-file|allow|doctor|self-test|uninstall|version>"
      );
      return 1;
  }
}

// only these commands read stdin; other commands (allow, version, ...) must dispatch immediately
// otherwise they would hang on the TTY waiting for EOF
export const STDIN_COMMANDS = new Set(["check-prompt", "check-file"]);

if (require.main === module) {
  const command = process.argv[2];
  const dispatch = (input: string) => {
    runCli(process.argv.slice(2), input).then((code) => { process.exitCode = code; });
  };
  if (!STDIN_COMMANDS.has(command)) {
    dispatch("");
  } else {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => dispatch(Buffer.concat(chunks).toString("utf8")));
  }
}
