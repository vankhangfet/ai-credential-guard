import { describe, it, expect } from "vitest";
import { maskSecret, isPlaceholder } from "../src/engine/mask";

describe("maskSecret", () => {
  it("giữ 6 đầu + *** + 4 cuối khi dài", () => {
    expect(maskSecret("sk-ant-api03-abcdef1234567890WXYZ")).toBe("sk-ant***WXYZ");
  });
  it("ngắn: 2 đầu + ***", () => {
    expect(maskSecret("shortkey12")).toBe("sh***");
  });
});

describe("isPlaceholder", () => {
  it("nhận placeholder rõ ràng", () => {
    for (const s of ["test", "TEST_KEY", "example", "xxxxx", "changeme", "dummy",
      "${API_KEY}", "<your-key>", "your-api-key", "***", "placeholder", "sample_key"]) {
      expect(isPlaceholder(s), s).toBe(true);
    }
  });
  it("giữ giá trị thật", () => {
    for (const s of ["AKIAIOSFODNN7EXAMPLE2", "s3cr3tV4lue!", "hunter2password"]) {
      expect(isPlaceholder(s), s).toBe(false);
    }
  });
});
