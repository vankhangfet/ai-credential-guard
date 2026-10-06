import { rmSync } from "node:fs";
import { join } from "node:path";
import { allAdapters } from "../adapters"; // import barrel để trigger đăng ký adapter
import { findProjectRoot } from "../root";
import { flagValue } from "../util/argv";

// Gỡ hook ai-guard khỏi mọi adapter đang detect được trong project.
// Mặc định giữ lại .ai-guard/ (config + audit log); --purge xóa hẳn thư mục này.
export async function uninstall(argv: string[]): Promise<number> {
  const start = flagValue(argv, "--root") ?? process.cwd();
  const purge = argv.includes("--purge");
  const root = findProjectRoot(start);
  if (!root) {
    process.stderr.write("ai-guard: không tìm thấy .ai-guard — không có gì để gỡ.\n");
    return 1;
  }
  let allOk = true;
  for (const a of allAdapters()) {
    let detected = false;
    try { detected = a.detect(root); } catch { detected = false; }
    if (!detected) continue;
    let r: { ok: boolean; detail: string };
    try { r = a.uninstall(root); } catch (e) { r = { ok: false, detail: String(e) }; }
    console.log(`${r.ok ? "✓" : "✗"} ${a.label}: ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  if (purge) {
    try {
      rmSync(join(root, ".ai-guard"), { recursive: true, force: true });
      console.log("✓ Đã xóa .ai-guard/ (bao gồm audit log).");
    } catch (e) {
      allOk = false;
      console.log(`✗ không xóa được .ai-guard/: ${e}`);
    }
  } else {
    console.log("Giữ lại .ai-guard/ (config + audit log). Dùng --purge để xóa hẳn.");
  }
  return allOk ? 0 : 1;
}
