import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface BypassFlag {
  scope: "prompt" | "file";
  pathHash?: string;
  grantedAt: string;
  expiresAt: number; // epoch ms
  duration_min: number;
}

const bypassDir = (root: string) => join(root, ".ai-guard", ".bypass");

function flagName(scope: string, path?: string): string {
  const h = path ? createHash("sha1").update(path.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 12) : "all";
  return `${scope}-${h}.json`;
}

export function grantBypass(root: string, scope: "prompt" | "file", path: string | undefined, minutes: number): { duration_min: number } {
  const dir = bypassDir(root);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const flag: BypassFlag = {
    scope,
    pathHash: path ? flagName(scope, path).split("-")[1] : undefined,
    grantedAt: new Date(now).toISOString(),
    expiresAt: now + minutes * 60_000,
    duration_min: minutes,
  };
  writeFileSync(join(dir, flagName(scope, path)), JSON.stringify(flag));
  return { duration_min: minutes };
}

export function hasValidBypass(root: string, scope: "prompt" | "file", path?: string): boolean {
  const dir = bypassDir(root);
  try {
    if (!existsSync(dir)) return false;
    // dọn flag hết hạn
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const flag = JSON.parse(readFileSync(join(dir, f), "utf8")) as BypassFlag;
        if (flag.expiresAt <= Date.now()) rmSync(join(dir, f));
      } catch { rmSync(join(dir, f)); }
    }
    const target = join(dir, flagName(scope, path));
    if (!existsSync(target)) return false;
    const flag = JSON.parse(readFileSync(target, "utf8")) as BypassFlag;
    return flag.scope === scope && flag.expiresAt > Date.now();
  } catch {
    return false;
  }
}
