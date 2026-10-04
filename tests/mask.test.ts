import { describe, it, expect } from "vitest";
import { maskSecret, isPlaceholder } from "../src/engine/mask";

describe("maskSecret", () => {
  it("giữ 6 đầu + *** + 4 cuối khi dài", () => {
    expect(maskSecret("sk-ant-api03-abcdef1234567890WXYZ")).toBe("sk-ant***WXYZ");
  });
  it("ngắn: 2 đầu + ***", () => {
    expect(maskSecret("shortkey12")).toBe("sh***");
  });
  it("rất ngắn (<=4): che toàn bộ", () => {
    expect(maskSecret("abcd")).toBe("***");
  });
  it("biên 11 ký tự: 2 đầu + ***", () => {
    expect(maskSecret("abcdefghijk")).toBe("ab***");
  });
  it("biên 15 ký tự: 6 đầu + *** + 4 cuối", () => {
    expect(maskSecret("abcdefghijklmno")).toBe("abcdef***lmno");
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
  it("giữ secret thật bắt đầu bằng my/your (regression)", () => {
    for (const s of ["MyS3cr3tP@ss2024", "mysql_root_pw_9x8Y7z!", "your-real-secret-9x!"]) {
      expect(isPlaceholder(s), s).toBe(false);
    }
  });
  it("nhận dạng keyword my/your + change_me", () => {
    for (const s of ["my-api-key", "your_token", "myapikey", "change_me"]) {
      expect(isPlaceholder(s), s).toBe(true);
    }
  });
});
