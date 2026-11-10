import { describe, it, expect } from "vitest";
import { scanWithJev, probeJev } from "../src/engine/jev";
import type { JevConfig } from "../src/types";

const baseCfg: JevConfig = {
  enabled: true,
  endpoint: "http://localhost:8000/decide",
  apiKeyEnv: "JEV_API_KEY",
  mode: "warn",
  threshold: 0.8,
  timeoutMs: 1000,
};

// Fake fetch returns preset JSON and lets the test inspect the request that was sent.
function fakeFetch(json: unknown, ok = true, capture?: (url: string, init: any) => void): typeof fetch {
  return (async (url: string, init: any) => {
    capture?.(url, init);
    return {
      ok,
      status: ok ? 200 : 500,
      text: async () => JSON.stringify(json),
    } as any;
  }) as any;
}

describe("scanWithJev", () => {
  it("disabled -> returns [] and does NOT call fetch", async () => {
    let called = false;
    const f = (async () => { called = true; return { ok: true, status: 200, text: async () => "{}" } as any; }) as any;
    const out = await scanWithJev("AKIA...", { ...baseCfg, enabled: false }, f);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("empty text -> [] without calling fetch", async () => {
    let called = false;
    const f = (async () => { called = true; return { ok: true, status: 200, text: async () => "{}" } as any; }) as any;
    expect(await scanWithJev("   ", baseCfg, f)).toEqual([]);
    expect(called).toBe(false);
  });

  it("probability >= threshold -> Finding with severity per mode", async () => {
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

  it("default questionType sends noul questions with true/false criteria", async () => {
    let sent: any;
    await scanWithJev("x", baseCfg, fakeFetch({}, true, (_u, init) => { sent = JSON.parse(init.body); }));
    expect(sent.questions["jev-credential"].type).toBe("noul");
    expect(Object.keys(sent.questions["jev-credential"].criteria)).toEqual(["true", "false"]);
  });

  it("questionType=choice sends yes/no options and reads probabilities.yes", async () => {
    let sent: any;
    // response shape captured from a choice-only gateway (prdcv-de-systemone)
    const json = { model: "m", answers: {
      "jev-credential": { type: "choice", choice: "no", confidence: 0.9971, probabilities: { yes: 0.0014, no: 0.9986 } },
      "jev-unauthorized-access": { type: "choice", choice: "yes", confidence: 0.9997, probabilities: { yes: 0.9999, no: 0.0001 } },
    } };
    const out = await scanWithJev("x", { ...baseCfg, questionType: "choice", mode: "block" },
      fakeFetch(json, true, (_u, init) => { sent = JSON.parse(init.body); }));
    expect(sent.questions["jev-credential"].type).toBe("choice");
    expect(Object.keys(sent.questions["jev-credential"].criteria)).toEqual(["yes", "no"]);
    expect(out.map((f) => f.ruleId)).toEqual(["jev-unauthorized-access"]);
    expect(out[0].severity).toBe("block");
    expect(out[0].description).toContain("100% confidence");
  });

  it("probabilities{yes,no} shape is parsed correctly", async () => {
    const json = { results: [{ id: "jev-unauthorized-access", probabilities: { yes: 0.88, no: 0.12 } }] };
    const out = await scanWithJev("x", baseCfg, fakeFetch(json));
    expect(out.length).toBe(1);
    expect(out[0].ruleId).toBe("jev-unauthorized-access");
  });

  it("id->number map shape is parsed correctly", async () => {
    const json = { "jev-credential": 0.99 };
    const out = await scanWithJev("x", baseCfg, fakeFetch(json));
    expect(out.length).toBe(1);
  });

  it("choice=no with high probability -> inverted to low P(yes) -> []", async () => {
    const json = { answers: [{ id: "jev-credential", choice: "no", probability: 0.95 }] };
    expect(await scanWithJev("x", baseCfg, fakeFetch(json))).toEqual([]);
  });

  it("HTTP not ok -> [] (fail-open)", async () => {
    const out = await scanWithJev("x", baseCfg, fakeFetch({ answers: [{ id: "jev-credential", probability: 1 }] }, false));
    expect(out).toEqual([]);
  });

  it("fetch throw (network/timeout) -> [] (fail-open)", async () => {
    const f = (async () => { throw new Error("network"); }) as any;
    expect(await scanWithJev("x", baseCfg, f)).toEqual([]);
  });

  it("sends to the correct endpoint, 2 questions, and Bearer key from env", async () => {
    process.env.JEV_API_KEY = "sk-test-123";
    let seenUrl = "";
    let seenInit: any = null;
    const f = fakeFetch({ answers: [] }, true, (u, i) => { seenUrl = u; seenInit = i; });
    await scanWithJev("hello", baseCfg, f);
    delete process.env.JEV_API_KEY;
    expect(seenUrl).toBe(baseCfg.endpoint);
    expect(seenInit.headers.authorization).toBe("Bearer sk-test-123");
    const body = JSON.parse(seenInit.body);
    // actual contract: { model, state, questions: { id: {type:"noul", instructions, criteria} } }
    expect(body.state).toBe("hello");
    expect(typeof body.model).toBe("string");
    expect(Object.keys(body.questions).sort()).toEqual(["jev-credential", "jev-unauthorized-access"]);
    expect(body.questions["jev-credential"].type).toBe("noul");
    expect(typeof body.questions["jev-credential"].instructions).toBe("string");
  });

  it("official response { answers: { id: { type:'noul', noul } } } -> Finding", async () => {
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

  it("cfg.model is sent; defaults to jev-latest", async () => {
    let body: any;
    const cap = (_u: string, i: any) => { body = JSON.parse(i.body); };
    await scanWithJev("x", { ...baseCfg, model: "typesafe/jev-1.13" }, fakeFetch({ answers: {} }, true, cap));
    expect(body.model).toBe("typesafe/jev-1.13");
    await scanWithJev("x", baseCfg, fakeFetch({ answers: {} }, true, cap));
    expect(body.model).toBe("jev-latest");
  });

  it("no env key -> sent without Authorization (local openjev-server)", async () => {
    delete process.env.JEV_API_KEY;
    let seenInit: any = null;
    const f = fakeFetch({ answers: [] }, true, (_u, i) => { seenInit = i; });
    await scanWithJev("hello", baseCfg, f);
    expect(seenInit.headers.authorization).toBeUndefined();
  });
});

describe("probeJev (doctor connectivity check)", () => {
  const res = (status: number, body: string) => (async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })) as any;

  it("disabled -> not ok, no request", async () => {
    expect((await probeJev({ ...baseCfg, enabled: false })).ok).toBe(false);
  });

  it("valid choice answer -> ok", async () => {
    const body = JSON.stringify({ answers: { "jev-credential": { type: "choice", choice: "no", probabilities: { yes: 0, no: 1 } } } });
    const r = await probeJev({ ...baseCfg, questionType: "choice" }, res(200, body));
    expect(r.ok).toBe(true);
  });

  it("server error message is surfaced (unsupported question type)", async () => {
    const body = JSON.stringify({ error: { code: "unsupported_question_type", message: "Only question type 'choice' is supported." } });
    const r = await probeJev(baseCfg, res(400, body));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("HTTP 400");
    expect(r.detail).toContain("Only question type 'choice' is supported.");
  });

  it("401 -> hint about the API key env var", async () => {
    const r = await probeJev(baseCfg, res(401, ""));
    expect(r.detail).toContain("(empty body)");
    expect(r.detail).toContain("JEV_API_KEY");
  });

  it("200 with unparseable shape -> not ok", async () => {
    const r = await probeJev(baseCfg, res(200, "<html>login</html>"));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("unsupported response shape");
  });

  it("network error -> not ok, never throws", async () => {
    const f = (async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as any;
    const r = await probeJev(baseCfg, f);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ECONNREFUSED");
  });
});
