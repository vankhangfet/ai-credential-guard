import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMarkedSection } from "../src/adapters/hooks-json";

// Fix 4 (coordinator): lock behavior khi content có start-marker nhưng KHÔNG có end-marker —
// removeMarkedSection truncate từ start-marker đến cuối file (section rác/orphan không làm
// uninstall sót content của ai-guard).
describe("hooks-json removeMarkedSection", () => {
  it("start-marker mà KHÔNG có end-marker -> truncate từ start; không marker -> null", () => {
    const dir = mkdtempSync(join(tmpdir(), "aig-hj-"));
    const file = join(dir, "instructions.md");
    writeFileSync(file, "# Team rules\n\n<!-- ai-guard:start -->\norphan section thiếu end marker\n");
    expect(removeMarkedSection(file)).toBe("# Team rules");
    const noMarker = join(dir, "no-marker.md");
    writeFileSync(noMarker, "plain user content\n");
    expect(removeMarkedSection(noMarker)).toBe(null);
  });
});
