import { flagValue } from "../util/argv";
import { appendAuditEvent } from "../audit/log";
import { grantBypass } from "../bypass/store";
import { findProjectRoot } from "../root";

export async function allow(argv: string[]): Promise<number> {
  const root = flagValue(argv, "--root") ?? process.cwd();
  const projectRoot = findProjectRoot(root);
  if (!projectRoot) {
    process.stderr.write("ai-guard: no .ai-guard found — run `npx ai-guard init` first.\n");
    return 1;
  }
  const scope = argv[0];
  if (scope !== "prompt" && scope !== "file") {
    process.stderr.write("ai-guard: use `ai-guard allow prompt --5m` or `ai-guard allow file <path> --10m`\n");
    return 1;
  }
  const minutesFlag = argv.find((a) => /^--\d+m$/.test(a));
  if (!minutesFlag) {
    process.stderr.write("ai-guard: missing duration, e.g. --5m or --10m\n");
    return 1;
  }
  const minutes = parseInt(minutesFlag.slice(2), 10);
  if (!(minutes >= 1 && minutes <= 1440)) {
    process.stderr.write("ai-guard: duration must be between 1 and 1440 minutes (24h)\n");
    return 1;
  }
  const path = scope === "file"
    ? argv.find((a, i) => i > 0 && !a.startsWith("--") && a !== minutesFlag && a !== flagValue(argv, "--root"))
    : undefined;
  if (scope === "file" && !path) {
    process.stderr.write("ai-guard: missing path, e.g. `ai-guard allow file .env --10m`\n");
    return 1;
  }
  grantBypass(projectRoot, scope, path, minutes);
  appendAuditEvent(projectRoot, {
    ts: new Date().toISOString(), tool: "user", event: "bypass", action: "bypass_granted",
    scope, path, duration_min: minutes,
  });
  process.stdout.write(`ai-guard: allowed ${scope}${path ? " " + path : ""} for ${minutes} minutes (audit logged).\n`);
  return 0;
}
