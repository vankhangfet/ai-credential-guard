import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function findProjectRoot(startDir: string): string | null {
  if (process.env.AI_GUARD_ROOT) {
    const envRoot = resolve(process.env.AI_GUARD_ROOT);
    return existsSync(envRoot) ? envRoot : null;
  }
  let dir = isAbsolute(startDir) ? startDir : resolve(startDir);
  // limit depth to 30 levels
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, ".ai-guard"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
