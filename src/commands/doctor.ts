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
    process.stderr.write("ai-guard: không tìm thấy .ai-guard — chạy `npx ai-guard init`.\n");
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
  } catch (e) {
    allOk = false;
    console.log("  ✗ lỗi load rules/config: " + e);
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
    console.log("⚠ Không phát hiện adapter nào — chưa có tool nào được bảo vệ. Chạy `npx ai-guard init`.");
  }
  return allOk ? 0 : 1;
}
