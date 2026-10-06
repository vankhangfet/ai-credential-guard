import { existsSync, readFileSync } from "node:fs";
import { MARKER } from "../util/json-config";

export interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type: string; command: string }>;
}

export const SECTION_MARKER = "<!-- ai-guard:start -->";

// Đã có entry của ai-guard cho cmdPart ("check-prompt" | "check-file") trong event list chưa? (idempotency)
export function entriesWithMarker(list: HookEntry[] | undefined, cmdPart: string): boolean {
  return !!list?.some((e) => (e.hooks ?? []).some((h) => h.command.includes(MARKER) && h.command.includes(cmdPart)));
}

// Giữ lại entry của user, bỏ entry của ai-guard (uninstall).
export function stripMarkerEntries(list: HookEntry[]): HookEntry[] {
  return list.filter((e) => !(e.hooks ?? []).some((h) => h.command.includes(MARKER)));
}

// Atomic append: đọc file hiện tại + kiểm tra marker TRƯỚC khi mutate config nào.
// Trả về nội dung mới cần ghi, hoặc null nếu không cần ghi (đã có section).
export function appendMarkedSection(file: string, section: string, marker: string = SECTION_MARKER): string | null {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes(marker)) return null;
  return current + (current && !current.endsWith("\n") ? "\n" : "") + section;
}

const SECTION_END = "<!-- ai-guard:end -->";

// Inverse của appendMarkedSection (uninstall education file): bỏ section marker-guarded,
// GIỮ content user còn lại. Trả về null nếu file không có marker (không phải của ai-guard —
// đừng đụng); trả về chuỗi CÓ THỂ RỖNG — rỗng nghĩa là sau khi bỏ section không còn gì
// -> caller nên xóa luôn file (file vốn chỉ do ai-guard tạo).
export function removeMarkedSection(file: string, marker: string = SECTION_MARKER): string | null {
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  const start = content.indexOf(marker);
  if (start < 0) return null;
  let end = content.indexOf(SECTION_END, start);
  end = end < 0 ? content.length : end + SECTION_END.length;
  return (content.slice(0, start) + content.slice(end)).trim();
}

// Trả về candidate đầu tiên tồn tại (src: <repo>/src/adapters -> ../../templates; dist: <pkg>/dist/adapters -> ../../templates).
export function templatePath(...candidates: string[]): string {
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[candidates.length - 1];
}
