import { describe, it, expect } from "vitest";
import { shannonEntropy, isHighEntropyToken } from "../src/engine/entropy";

describe("shannonEntropy", () => {
  it("chuỗi lặp = entropy thấp", () => {
    expect(shannonEntropy("aaaaaaaaaa")).toBeCloseTo(0, 1);
  });
  it("chuỗi đa dạng = entropy cao", () => {
    expect(shannonEntropy("aB3$xY9!kQ2#mZ7&")).toBeGreaterThan(3.5);
  });
});

describe("isHighEntropyToken", () => {
  it("token dài đa charset = true", () => {
    expect(isHighEntropyToken("fJ3$kQ9#mZ7&xY2!aB8%")).toBe(true);
  });
  it("từ tiếng Anh thường = false", () => {
    expect(isHighEntropyToken("configuration")).toBe(false);
  });
  it("chuỗi lặp = false", () => {
    expect(isHighEntropyToken("aaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });
  it("ngắn hơn 20 ký tự = false", () => {
    expect(isHighEntropyToken("aB3$xY9!")).toBe(false);
  });
});
