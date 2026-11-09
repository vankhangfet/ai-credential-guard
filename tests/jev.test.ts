import { describe, it, expect } from "vitest";
import { scanWithJev } from "../src/engine/jev";
import type { JevConfig } from "../src/types";

const baseCfg: JevConfig = {
  enabled: true,
  endpoint: "http://localhost:8000/decide",
  apiKeyEnv: "JEV_API_KEY",
  mode: "warn",
  threshold: 0.8,
  timeoutMs: 1000,
};

// Fake fetch trả về JSON cho sẵn và cho phép kiểm tra request đã gửi.
function fakeFetch(json: unknown, ok = true, capture?: (url: string, init: any) => void): typeof fetch {
  return (async (url: string, init: any) => {
    capture?.(url, init);
    return {
      ok,
      json: async () => json,
    } as any;
  }) as any;
}

describe("scanWithJev", () => {
  it("disabled -> trả [] và KHÔNG gọi fetch", async () => {
    let called = false;
    const f = (async () => { called = true; return { ok: true, json: async () => ({}) } as any; }) as any;
    const out = await scanWithJev("AKIA...", { ...baseCfg, enabled: false }, f);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("text rỗng -> [] không gọi fetch", async () => {
    let called = false;
    const f = (async () => { called = true; return { ok: true, json: async () => ({}) } as any; }) as any;
    expect(await scanWithJev("   ", baseCfg, f)).toEqual([]);
    expect(called).toBe(false);
  });

  it("probability >= threshold -> Finding với severity theo mode", async () => {
    const json = { answers: [{ id: "jev-credential", probability: 0.95 }, { id: "jev-unauthorized-access", probability: 0.1 }] };
    const out = await scanWithJev("some text", baseCfg, fakeFetch(json));
    expect(out.length).toBe(1);
    expect(out[0].ruleId).toBe("jev-credential");
    expect(out[0].severity).toBe("warn");
    expect(out[0].description).toContain("95% confidence");
  });

  it("mode=block -> Finding severity block", async () => {
    const json = { answers: [{ id: "jev-credential", score: 0.9 }] };
    const out = await scanWithJev("x", { ...baseCfg, mode: "block" }, fakeFetch(json));
    expect(out[0].severity).toBe("block");
  });

  it("probability < threshold -> []", async () => {
    const json = { answers: [{ id: "jev-credential", probability: 0.5 }] };
    expect(await scanWithJev("x", baseCfg, fakeFetch(json))).toEqual([]);
  });

  it("shape probabilities{yes,no} được hiểu đúng", async () => {
    const json = { results: [{ id: "jev-unauthorized-access", probabilities: { yes: 0.88, no: 0.12 } }] };
    const out = await scanWithJev("x", baseCfg, fakeFetch(json));
    expect(out.length).toBe(1);
    expect(out[0].ruleId).toBe("jev-unauthorized-access");
  });

  it("shape map id->number được hiểu đúng", async () => {
    const json = { "jev-credential": 0.99 };
    const out = await scanWithJev("x", baseCfg, fakeFetch(json));
    expect(out.length).toBe(1);
  });

  it("choice=no với probability cao -> đảo thành P(yes) thấp -> []", async () => {
    const json = { answers: [{ id: "jev-credential", choice: "no", probability: 0.95 }] };
    expect(await scanWithJev("x", baseCfg, fakeFetch(json))).toEqual([]);
  });

  it("HTTP không ok -> [] (fail-open)", async () => {
    const out = await scanWithJev("x", baseCfg, fakeFetch({ answers: [{ id: "jev-credential", probability: 1 }] }, false));
    expect(out).toEqual([]);
  });

  it("fetch throw (mạng/timeout) -> [] (fail-open)", async () => {
    const f = (async () => { throw new Error("network"); }) as any;
    expect(await scanWithJev("x", baseCfg, f)).toEqual([]);
  });

  it("gửi đúng endpoint, 2 câu hỏi, và Bearer key từ env", async () => {
    process.env.JEV_API_KEY = "sk-test-123";
    let seenUrl = "";
    let seenInit: any = null;
    const f = fakeFetch({ answers: [] }, true, (u, i) => { seenUrl = u; seenInit = i; });
    await scanWithJev("hello", baseCfg, f);
    delete process.env.JEV_API_KEY;
    expect(seenUrl).toBe(baseCfg.endpoint);
    expect(seenInit.headers.authorization).toBe("Bearer sk-test-123");
    const body = JSON.parse(seenInit.body);
    // contract thật: { model, state, questions: { id: {type:"noul", instructions, criteria} } }
    expect(body.state).toBe("hello");
    expect(typeof body.model).toBe("string");
    expect(Object.keys(body.questions).sort()).toEqual(["jev-credential", "jev-unauthorized-access"]);
    expect(body.questions["jev-credential"].type).toBe("noul");
    expect(typeof body.questions["jev-credential"].instructions).toBe("string");
  });

  it("response chính thức { answers: { id: { type:'noul', noul } } } -> Finding", async () => {
    const json = {
      model: "jev-latest",
      answers: {
        "jev-credential": { type: "noul", noul: 0.93 },
        "jev-unauthorized-access": { type: "noul", noul: 0.02 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    const out = await scanWithJev("x", baseCfg, fakeFetch(json));
    expect(out.map((f) => f.ruleId)).toEqual(["jev-credential"]);
    expect(out[0].description).toContain("93% confidence");
  });

  it("cfg.model được gửi lên; mặc định jev-latest", async () => {
    let body: any;
    const cap = (_u: string, i: any) => { body = JSON.parse(i.body); };
    await scanWithJev("x", { ...baseCfg, model: "typesafe/jev-1.13" }, fakeFetch({ answers: {} }, true, cap));
    expect(body.model).toBe("typesafe/jev-1.13");
    await scanWithJev("x", baseCfg, fakeFetch({ answers: {} }, true, cap));
    expect(body.model).toBe("jev-latest");
  });

  it("không có env key -> gửi không kèm Authorization (local openjev-server)", async () => {
    delete process.env.JEV_API_KEY;
    let seenInit: any = null;
    const f = fakeFetch({ answers: [] }, true, (_u, i) => { seenInit = i; });
    await scanWithJev("hello", baseCfg, f);
    expect(seenInit.headers.authorization).toBeUndefined();
  });
});
