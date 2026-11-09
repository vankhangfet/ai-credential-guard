import { existsSync, readFileSync } from "node:fs";
import { MARKER } from "../util/json-config";

export interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type: string; command: string }>;
}

export const SECTION_MARKER = "<!-- ai-guard:start -->";

// Does the event list already contain an ai-guard entry for cmdPart ("check-prompt" | "check-file")? (idempotency)
export function entriesWithMarker(list: HookEntry[] | undefined, cmdPart: string): boolean {
  return !!list?.some((e) => (e.hooks ?? []).some((h) => h.command.includes(MARKER) && h.command.includes(cmdPart)));
}

// Keep user entries, drop ai-guard entries (uninstall).
export function stripMarkerEntries(list: HookEntry[]): HookEntry[] {
  return list.filter((e) => !(e.hooks ?? []).some((h) => h.command.includes(MARKER)));
}

// Atomic append: read the current file + check the marker BEFORE mutating any config.
// Returns the new content to write, or null if nothing to write (section already present).
export function appendMarkedSection(file: string, section: string, marker: string = SECTION_MARKER): string | null {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes(marker)) return null;
  return current + (current && !current.endsWith("\n") ? "\n" : "") + section;
}

const SECTION_END = "<!-- ai-guard:end -->";

// Inverse of appendMarkedSection (uninstall education file): remove the marker-guarded section,
// KEEP the remaining user content. Returns null if the file has no marker (not ai-guard's —
// don't touch it); returns a string that MAY BE EMPTY — empty means nothing remains after
// removing the section -> the caller should delete the file (it was created solely by ai-guard).
export function removeMarkedSection(file: string, marker: string = SECTION_MARKER): string | null {
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  const start = content.indexOf(marker);
  if (start < 0) return null;
  let end = content.indexOf(SECTION_END, start);
  end = end < 0 ? content.length : end + SECTION_END.length;
  return (content.slice(0, start) + content.slice(end)).trim();
}

// Returns the first candidate that exists (src: <repo>/src/adapters -> ../../templates; dist: <pkg>/dist/adapters -> ../../templates).
export function templatePath(...candidates: string[]): string {
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[candidates.length - 1];
}
