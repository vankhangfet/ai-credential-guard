import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allAdapters } from "../adapters";
import type { InstallResult } from "../adapters/types";
import { flagValue } from "../util/argv";

const DEFAULT_RULES = {
  add: [{ id: "example-internal", severity: "block", pattern: "CORP-[A-Z0-9]{8,}", description: "Example: replace with your internal token format" }],
  override: {},
  remove: [],
};
const DEFAULT_CONFIG = { sensitivePaths: null, genericSecret: true, highEntropy: true };

export async function init(argv: string[], _input: string): Promise<number> {
  const root = flagValue(argv, "--root") ?? process.cwd();
  const noInstructions = argv.includes("--no-instructions");
  const wanted = flagValue(argv, "--tools")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

  const adapters = allAdapters();
  const detected = adapters.filter((a) => (wanted ? wanted.includes(a.id) : a.detect(root)));
  const unknown = wanted ? wanted.filter((w) => !adapters.some((a) => a.id === w)) : [];
  if (unknown.length) {
    process.stderr.write(`ai-guard: --tools contains unsupported id(s): ${unknown.join(", ")} (supported: ${adapters.map((a) => a.id).join(", ")})\n`);
  }
  if (!detected.length) {
    process.stderr.write([
      "ai-guard: no AI tools detected in this project.",
      "Checked for: .claude, .codex, .opencode, .pi, .cline, .kiro, .vscode",
      "Use: npx ai-guard init --tools claude-code,codex,opencode,pi,cline,kiro,copilot",
    ].join("\n") + "\n");
    return 1;
  }

  // 1) cấu trúc .ai-guard
  mkdirSync(join(root, ".ai-guard", "logs"), { recursive: true });
  mkdirSync(join(root, ".ai-guard", ".bypass"), { recursive: true });
  const rulesFile = join(root, ".ai-guard", "rules.json");
  const configFile = join(root, ".ai-guard", "config.json");
  if (!existsSync(rulesFile)) writeFileSync(rulesFile, JSON.stringify(DEFAULT_RULES, null, 2) + "\n");
  if (!existsSync(configFile)) writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");

  // 2) .gitignore
  const giPath = join(root, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const additions = [".ai-guard/logs/", ".ai-guard/.bypass/"].filter((l) => !gi.includes(l));
  if (additions.length) appendFileSync(giPath, (gi && !gi.endsWith("\n") ? "\n" : "") + "# ai-guard\n" + additions.join("\n") + "\n");

  // 3) install adapters
  const results: InstallResult[] = [];
  for (const a of detected) {
    results.push(a.install(root, { instructions: !noInstructions }));
  }

  // 4) summary
  console.log("ai-guard: initialized.");
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.adapter}: ${r.detail}`);
  console.log("  Rule config: .ai-guard/rules.json — audit log: .ai-guard/logs/");
  console.log("  Note: rules.json ships a demo rule 'example-internal' (CORP-*) enabled — edit or remove as needed.");
  console.log("  Verify: npx ai-guard doctor");
  console.log("  Note: add ai-credential-guard to devDependencies (npm i -D ai-credential-guard) so hooks run without network.");
  return results.some((r) => !r.ok) ? 1 : 0;
}
