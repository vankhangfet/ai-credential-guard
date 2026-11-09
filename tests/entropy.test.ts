import { describe, it, expect } from "vitest";
import { shannonEntropy, isHighEntropyToken } from "../src/engine/entropy";

describe("shannonEntropy", () => {
  it("repeated string = low entropy", () => {
    expect(shannonEntropy("aaaaaaaaaa")).toBeCloseTo(0, 1);
  });
  it("diverse string = high entropy", () => {
    expect(shannonEntropy("aB3$xY9!kQ2#mZ7&")).toBeGreaterThan(3.5);
  });
});

describe("isHighEntropyToken", () => {
  it("long multi-charset token = true", () => {
    expect(isHighEntropyToken("fJ3$kQ9#mZ7&xY2!aB8%")).toBe(true);
  });
  it("ordinary English word = false", () => {
    expect(isHighEntropyToken("configuration")).toBe(false);
  });
  it("repeated string = false", () => {
    expect(isHighEntropyToken("aaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });
  it("shorter than 20 characters = false", () => {
    expect(isHighEntropyToken("aB3$xY9!")).toBe(false);
  });
});
