import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdapterBase, InstallOptions, InstallResult } from "./types";
import { MARKER } from "../util/json-config";
import { templatePath } from "./hooks-json";

// Cline (v3.36+) KHÔNG dùng config hooks JSON kiểu Claude Code — mỗi event là MỘT script
// thực thi tại `.clinerules/hooks/<EventType>` (tên file = tên event, KHÔNG extension, phải +x).
// Nguồn: blog chính thức https://cline.bot/blog/cline-v3-36-hooks + dev.to (9/2026) + maybedont.ai.
// docs.cline.bot getting-started/config.md mô tả layout mới hơn (`.cline/` chứa hooks/...) nên
// detect chấp nhận CẢ `.clinerules` LẪN `.cline`; install luôn ghi vào `.clinerules/hooks/`
// (layout được nhiều nguồn độc lập xác nhận nhất hiện nay).
interface HookSpec {
  rel: string[]; // path thành phần (posix) relative to project root
  template: string; // tên file trong templates/
}

// DIVERGENCE vs spec ("Cline chưa expose prompt hook"): Step 0 verified Cline v3.36 CÓ
// UserPromptSubmit (payload: prompt text + attachments) -> đăng ký cả prompt-side.
const HOOKS: HookSpec[] = [
  { rel: [".clinerules", "hooks", "PreToolUse"], template: "cline-hook-pretooluse.js" },
  { rel: [".clinerules", "hooks", "UserPromptSubmit"], template: "cline-hook-userpromptsubmit.js" },
];

// src: <repo>/src/adapters -> ../../templates; dist: <pkg>/dist/adapters -> ../../templates
const templateCandidates = (name: string) => [
  join(__dirname, "..", "..", "templates", name),
  join(__dirname, "..", "..", "..", "templates", name),
];

export const clineAdapter: AdapterBase = {
  id: "cline",
  label: "Cline",
  detect: (root) => existsSync(join(root, ".clinerules")) || existsSync(join(root, ".cline")),
  install(root: string, _opts: InstallOptions): InstallResult {
    try {
      // Atomic install: kiểm tra MỌI slot TRƯỚC khi mutate file nào. Slot `.clinerules/hooks/<Event>`
      // là slot CHÍNH của event (không merge JSON được như Claude Code) — hook lạ của user chiếm
      // slot thì TỪ CHỐI ghi đè thay vì phá config user.
      const foreign = HOOKS.map((h) => join(root, ...h.rel)).filter(
        (dest) => existsSync(dest) && !readFileSync(dest, "utf8").includes(MARKER),
      );
      if (foreign.length) {
        return {
          adapter: "cline",
          ok: false,
          detail: `user hook already exists (not overwriting): ${foreign.map((f) => f.slice(root.length + 1)).join(", ")} — merge manually and re-run`,
        };
      }
      for (const h of HOOKS) {
        const dest = join(root, ...h.rel);
        const content = readFileSync(templatePath(...templateCandidates(h.template)), "utf8");
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        chmodSync(dest, 0o755); // Cline yêu cầu script thực thi được (no-op trên Windows)
      }
      // Instructions: bỏ qua — Cline dùng `.clinerules/` cho rules nhưng layout (file đơn vs
      // `.clinerules/*.md` vs `.cline/rules/` của docs mới) chưa thống nhất giữa các nguồn;
      // chưa xác định được vị trí education an toàn (follow-up).
      return {
        adapter: "cline",
        ok: true,
        detail: "hooks PreToolUse + UserPromptSubmit installed (.clinerules/hooks/, requires Cline >=3.36 + enable Features > Hooks)",
      };
    } catch (e) {
      return { adapter: "cline", ok: false, detail: String(e) };
    }
  },
  uninstall(root: string): InstallResult {
    try {
      let removed = 0;
      for (const h of HOOKS) {
        const dest = join(root, ...h.rel);
        if (!existsSync(dest)) continue;
        // Chỉ xóa file của mình: hook lạ (không marker) tại đúng slot đó thì giữ nguyên.
        if (!readFileSync(dest, "utf8").includes(MARKER)) continue;
        rmSync(dest);
        removed++;
      }
      return {
        adapter: "cline",
        ok: true,
        detail: removed ? `ai-guard hooks removed (${removed} file(s))` : "no ai-guard hooks — nothing to remove",
      };
    } catch (e) {
      return { adapter: "cline", ok: false, detail: String(e) };
    }
  },
  doctor(root: string) {
    const missing = HOOKS.filter((h) => !existsSync(join(root, ...h.rel))).map((h) => h.rel.join("/"));
    if (missing.length) {
      return { ok: false, detail: `missing ai-guard hooks: ${missing.join(", ")} in .clinerules/hooks/` };
    }
    const foreign = HOOKS.filter((h) => !readFileSync(join(root, ...h.rel), "utf8").includes(MARKER)).map((h) => h.rel.join("/"));
    if (foreign.length) {
      return { ok: false, detail: `${foreign.join(", ")} exist but do not belong to ai-guard` };
    }
    return { ok: true, detail: "hooks installed (.clinerules/hooks/)" };
  },
};
