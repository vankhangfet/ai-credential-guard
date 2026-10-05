import { describe, it, expect } from "vitest";
import { scanText } from "../src/engine/scanner";
import { compileRules } from "../src/engine/rules";
import { builtInRules } from "../src/engine/rules";

const rules = compileRules(builtInRules);

describe("scanText pattern rules", () => {
  it("phát hiện AWS key và trả Finding masked", () => {
    const f = scanText("dùng key AKIAIOSFODNN7EXAMPLE nhé", rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    const aws = f.find((x) => x.ruleId === "aws-access-key");
    expect(aws).toBeTruthy();
    expect(aws!.severity).toBe("block");
    expect(aws!.preview).not.toContain("IOSFODNN7EXAMPLE");
  });
  it("nhiều rule khớp -> nhiều findings, cap 20", () => {
    const f = scanText("AKIAIOSFODNN7EXAMPLE và ghp_" + "a".repeat(36), rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    expect(f.length).toBeGreaterThanOrEqual(2);
  });
});

describe("scanText generic-secret detector", () => {
  it("password=giá_trị_thật -> finding warn", () => {
    const f = scanText('DB_PASSWORD="s3cr3tV4lue!42"', rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "generic-secret" && x.severity === "warn")).toBe(true);
  });
  it("password=lowercase_random (entropy 3.5-4.2) -> vẫn phát hiện (regression Task 3 review)", () => {
    const f = scanText("password=geqnwqabdexnnzashcsp", rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "generic-secret")).toBe(true);
  });
  it("password=placeholder -> bỏ qua", () => {
    const f = scanText("DB_PASSWORD=changeme", rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "generic-secret")).toBe(false);
  });
  it("genericSecret:false -> tắt detector", () => {
    const f = scanText('DB_PASSWORD="s3cr3tV4lue!42"', rules, { genericSecret: false, highEntropy: false, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "generic-secret")).toBe(false);
  });
});

describe("scanText high-entropy detector", () => {
  it("token entropy cao -> finding warn", () => {
    const f = scanText("token: fJ3$kQ9#mZ7&xY2!aB8%qW5@", rules, { genericSecret: false, highEntropy: true, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "high-entropy")).toBe(true);
  });
  it("câu tiếng Anh thường -> không finding", () => {
    const f = scanText("this configuration uses standard parameters", rules, { genericSecret: false, highEntropy: true, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "high-entropy")).toBe(false);
  });
});

describe("scanText các bổ sung review", () => {
  it("MAX_FINDINGS cap 20 được ép buộc", () => {
    const many = Array.from({ length: 30 }, (_, i) => `password=realvalue${String(i).padStart(3, "0")}x!`).join("\n");
    const f = scanText(many, rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    expect(f.length).toBe(20);
  });
  it("keyword nhúng chữ (lookbehind chặn): MAXPASSWORD= không match", () => {
    const f = scanText("MAXPASSWORD=realvalue123", rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "generic-secret")).toBe(false);
  });
  it('JSON "password": "value" -> phát hiện', () => {
    const f = scanText('{"password": "s3cr3tV4lue!42"}', rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "generic-secret")).toBe(true);
  });
  it("SECRET_KEY django -> phát hiện", () => {
    const f = scanText("SECRET_KEY=django-insecure-v8fd#kq2!", rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    expect(f.some((x) => x.ruleId === "generic-secret")).toBe(true);
  });
  it("cùng giá trị lặp lại -> dedup 1 finding", () => {
    const f = scanText("a=s3cr3tX1&password=samevalue9 repeated password=samevalue9 again password=samevalue9", rules, { genericSecret: true, highEntropy: false, sensitivePaths: [] });
    const gs = f.filter((x) => x.ruleId === "generic-secret");
    expect(gs.length).toBe(1);
  });
});
