import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const MARKER = "ai-guard";

export function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function backupOnce(path: string): void {
  if (!existsSync(path)) return;
  const bak = path + ".aiguard.bak";
  if (!existsSync(bak)) copyFileSync(path, bak);
}

export function writeJson(path: string, data: unknown): void {
  backupOnce(path);
  const tmp = path + ".aiguard.tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}
