import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "../src/util/json-config";

describe("json-config", () => {
  it("readJson falls back when the file does not exist", () => {
    expect(readJson(join(tmpdir(), "no-" + Date.now() + ".json"), { a: 1 })).toEqual({ a: 1 });
  });
  it("writeJson creates a .aiguard.bak backup on first write, does not overwrite the old backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "aig-"));
    const f = join(dir, "settings.json");
    writeFileSync(f, "{\"old\":true}");
    writeJson(f, { old: true, hooks: {} });
    writeJson(f, { old: true, hooks: {}, extra: 1 }); // 2nd write
    expect(existsSync(f + ".aiguard.bak")).toBe(true);
    expect(JSON.parse(readFileSync(f + ".aiguard.bak", "utf8"))).toEqual({ old: true }); // still the FIRST version
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ old: true, hooks: {}, extra: 1 });
    expect(existsSync(f + ".aiguard.tmp")).toBe(false); // no leftover tmp
  });
});
