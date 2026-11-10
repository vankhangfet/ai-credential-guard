import { allAdapters } from "../adapters"; // import barrel to trigger adapter registration
import { selfTest, printSelfTest } from "./self-test";
import { findProjectRoot } from "../root";
import { loadRules, loadConfig } from "../engine/loader";
import { probeJev, jevCacheFile } from "../engine/jev";
import { logJevCall } from "../audit/log";
import { flagValue } from "../util/argv";

// Installation health check: engine self-test -> rules/config -> each detectable adapter.
export async function doctor(argv: string[]): Promise<number> {
  const start = flagValue(argv, "--root") ?? process.cwd();
  const root = findProjectRoot(start);
  if (!root) {
    process.stderr.write("ai-guard: no .ai-guard found — run `npx ai-guard init`.\n");
    return 1;
  }
  let allOk = true;

  // 1) engine
  const st = selfTest();
  printSelfTest(st, "Engine self-test", "  ");
  if (st.failures.length) allOk = false;

  // 2) project rules/config
  try {
    const rules = loadRules(root);
    const cfg = loadConfig(root);
    console.log(`Rules: ${rules.length} (sensitive paths: ${cfg.sensitivePaths?.length ?? 0})`);
    // JEV / OpenJEV (optional decision API)
    if (cfg.jev?.enabled) {
      const keyVar = cfg.jev.apiKeyEnv ?? "JEV_API_KEY";
      const hasKey = !!process.env[keyVar];
      console.log(`JEV: enabled → ${cfg.jev.endpoint} (model=${cfg.jev.model ?? "jev-latest (default)"}, questionType=${cfg.jev.questionType ?? "noul"}, mode=${cfg.jev.mode}, threshold=${cfg.jev.threshold}, timeout=${cfg.jev.timeoutMs}ms)`);
      if (!cfg.jev.model) console.log("  ⚠ jev.model not set — using \"jev-latest\". Self-hosted servers (e.g. Ollama/OpenJev) need their own model id, else requests 404 and the check silently fails open.");
      console.log(`  ${hasKey ? "✓" : "⚠"} API key env ${keyVar}: ${hasKey ? "set" : "not set (sending unauthenticated — ok for local openjev-server)"}`);
      // live probe — the check itself fails open silently, so surface the server's real answer here
      const probe = await probeJev(cfg.jev, undefined, (info) => logJevCall(root, "doctor", "doctor", cfg.jev, info), { cacheFile: jevCacheFile(root) });
      console.log(`  ${probe.ok ? "✓" : "✗"} endpoint check: ${probe.detail}`);
      if (!probe.ok) {
        allOk = false;
        console.log("    (until this is fixed every JEV check fails open — prompts/files are NOT inspected by JEV)");
      }
    } else {
      console.log("JEV: disabled (optional — set jev.enabled + jev.endpoint in .ai-guard/config.json to enable)");
    }
  } catch (e) {
    allOk = false;
    console.log("  ✗ failed to load rules/config: " + e);
  }

  // 3) adapters in use in the project
  let detectedCount = 0;
  for (const a of allAdapters()) {
    let detected = false;
    try { detected = a.detect(root); } catch { detected = false; }
    if (!detected) continue;
    detectedCount++;
    let d: { ok: boolean; detail: string };
    try { d = a.doctor(root); } catch (e) { d = { ok: false, detail: String(e) }; }
    console.log(`${d.ok ? "✓" : "✗"} ${a.label}: ${d.detail}`);
    if (!d.ok) allOk = false;
  }
  if (detectedCount === 0) {
    console.log("⚠ No adapters detected — nothing is hooked. Run `npx ai-guard init`.");
  }
  return allOk ? 0 : 1;
}
