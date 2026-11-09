import { describe, it, expect } from "vitest";
import { maskSecret, isPlaceholder } from "../src/engine/mask";

describe("maskSecret", () => {
  it("keeps first 6 + *** + last 4 when long", () => {
    expect(maskSecret("sk-ant-api03-abcdef1234567890WXYZ")).toBe("sk-ant***WXYZ");
  });
  it("short: first 2 + ***", () => {
    expect(maskSecret("shortkey12")).toBe("sh***");
  });
  it("very short (<=4): fully masked", () => {
    expect(maskSecret("abcd")).toBe("***");
  });
  it("boundary at 11 characters: first 2 + ***", () => {
    expect(maskSecret("abcdefghijk")).toBe("ab***");
  });
  it("boundary at 15 characters: first 6 + *** + last 4", () => {
    expect(maskSecret("abcdefghijklmno")).toBe("abcdef***lmno");
  });
});

describe("isPlaceholder", () => {
  it("recognizes obvious placeholders", () => {
    for (const s of ["test", "TEST_KEY", "example", "xxxxx", "changeme", "dummy",
      "${API_KEY}", "<your-key>", "your-api-key", "***", "placeholder", "sample_key"]) {
      expect(isPlaceholder(s), s).toBe(true);
    }
  });
  it("keeps real values", () => {
    for (const s of ["AKIAIOSFODNN7EXAMPLE2", "s3cr3tV4lue!", "hunter2password"]) {
      expect(isPlaceholder(s), s).toBe(false);
    }
  });
  it("keeps real secrets starting with my/your (regression)", () => {
    for (const s of ["MyS3cr3tP@ss2024", "mysql_root_pw_9x8Y7z!", "your-real-secret-9x!"]) {
      expect(isPlaceholder(s), s).toBe(false);
    }
  });
  it("recognizes my/your keywords + change_me", () => {
    for (const s of ["my-api-key", "your_token", "myapikey", "change_me"]) {
      expect(isPlaceholder(s), s).toBe(true);
    }
  });
  it("no ReDoS on long input (200-character guard)", () => {
    const start = Date.now();
    expect(isPlaceholder("your-key" + "a".repeat(100_000) + "!")).toBe(false);
    expect(isPlaceholder("xxxxxxxx" + "x".repeat(100_000) + "!")).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });
  it("a value longer than 200 characters is never a placeholder", () => {
    expect(isPlaceholder("test_" + "a".repeat(300))).toBe(false);
  });
});
