import { describe, it, expect } from "vitest";
import { buildRulesArtifact } from "../src/scripts/export-rules";
import { builtInRules } from "../src/engine/rules";

describe("buildRulesArtifact", () => {
  it("mỗi rule có id/pattern/severity/description, không có trường re", () => {
    const arr = buildRulesArtifact();
    expect(arr.length).toBe(builtInRules.length);
    for (const r of arr) {
      expect(typeof r.id).toBe("string");
      expect(["block", "warn"]).toContain(r.severity);
      expect(typeof r.description).toBe("string");
      expect("re" in r).toBe(false);
    }
  });
});
