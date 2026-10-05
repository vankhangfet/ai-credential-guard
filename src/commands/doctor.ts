import { allAdapters } from "../adapters"; // import barrel để trigger đăng ký adapter
import { selfTest } from "./self-test";
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
  console.log(`Engine self-test: ${st.total - st.failures.length}/${st.total} pass`);
  if (st.failures.length) {
    allOk = false;
    st.failures.forEach((f) => console.log("  ✗ " + f));
  }

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
  for (const a of allAdapters()) {
    if (!a.detect(root)) continue;
    const d = a.doctor(root);
    console.log(`${d.ok ? "✓" : "✗"} ${a.label}: ${d.detail}`);
    if (!d.ok) allOk = false;
  }
  return allOk ? 0 : 1;
}
