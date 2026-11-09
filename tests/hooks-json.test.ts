import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMarkedSection } from "../src/adapters/hooks-json";

// Fix 4 (coordinator): lock behavior when content has a start-marker but NO end-marker —
// removeMarkedSection truncates from the start-marker to end of file (an orphan section
// must not leave ai-guard content behind after uninstall).
describe("hooks-json removeMarkedSection", () => {
  it("start-marker without end-marker -> truncate from start; no marker -> null", () => {
    const dir = mkdtempSync(join(tmpdir(), "aig-hj-"));
    const file = join(dir, "instructions.md");
    writeFileSync(file, "# Team rules\n\n<!-- ai-guard:start -->\norphan section missing end marker\n");
    expect(removeMarkedSection(file)).toBe("# Team rules");
    const noMarker = join(dir, "no-marker.md");
    writeFileSync(noMarker, "plain user content\n");
    expect(removeMarkedSection(noMarker)).toBe(null);
  });
});
