import { allAdapters } from "../adapters"; // import barrel để trigger đăng ký adapter
import { selfTest, printSelfTest } from "./self-test";
import { findProjectRoot } from "../root";
import { loadRules, loadConfig } from "../engine/loader";
import { flagValue } from "../util/argv";

// Kiểm tra sức khoẻ cài đặt: engine self-test -> rules/config -> từng adapter detect được.
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

  // 2) rules/config của project
  try {
    const rules = loadRules(root);
    const cfg = loadConfig(root);
    console.log(`Rules: ${rules.length} (sensitive paths: ${cfg.sensitivePaths?.length ?? 0})`);
    // JEV / OpenJEV (optional decision API)
    if (cfg.jev?.enabled) {
      const keyVar = cfg.jev.apiKeyEnv ?? "JEV_API_KEY";
      const hasKey = !!process.env[keyVar];
      console.log(`JEV: enabled → ${cfg.jev.endpoint} (model=${cfg.jev.model ?? "jev-latest (default)"}, mode=${cfg.jev.mode}, threshold=${cfg.jev.threshold}, timeout=${cfg.jev.timeoutMs}ms)`);
      if (!cfg.jev.model) console.log("  ⚠ jev.model not set — using \"jev-latest\". Self-hosted servers (e.g. Ollama/OpenJev) need their own model id, else requests 404 and the check silently fails open.");
      console.log(`  ${hasKey ? "✓" : "⚠"} API key env ${keyVar}: ${hasKey ? "set" : "not set (sending unauthenticated — ok for local openjev-server)"}`);
    } else {
      console.log("JEV: disabled (optional — set jev.enabled + jev.endpoint in .ai-guard/config.json to enable)");
    }
  } catch (e) {
    allOk = false;
    console.log("  ✗ failed to load rules/config: " + e);
  }

  // 3) adapters đang dùng trong project
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
