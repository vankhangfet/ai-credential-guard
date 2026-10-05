import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "../src/util/json-config";

describe("json-config", () => {
  it("readJson fallback khi file không tồn tại", () => {
    expect(readJson(join(tmpdir(), "no-" + Date.now() + ".json"), { a: 1 })).toEqual({ a: 1 });
  });
  it("writeJson tạo backup .aiguard.bak lần đầu, không đè backup cũ", () => {
    const dir = mkdtempSync(join(tmpdir(), "aig-"));
    const f = join(dir, "settings.json");
    writeFileSync(f, "{\"old\":true}");
    writeJson(f, { old: true, hooks: {} });
    writeJson(f, { old: true, hooks: {}, extra: 1 }); // lần 2
    expect(existsSync(f + ".aiguard.bak")).toBe(true);
    expect(JSON.parse(readFileSync(f + ".aiguard.bak", "utf8"))).toEqual({ old: true }); // vẫn bản ĐẦU
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ old: true, hooks: {}, extra: 1 });
    expect(existsSync(f + ".aiguard.tmp")).toBe(false); // không sót tmp
  });
});
