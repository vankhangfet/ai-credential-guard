#!/usr/bin/env node
// Mock JEV / OpenJEV server for LOCAL testing of ai-guard's jev integration.
// Speaks the System One contract: POST /v1/systemone
//   req : { model, state, questions: { id: { type:"noul", instructions, criteria } } }
//   resp: { model, answers: { id: { type:"noul", noul: <0..1> } }, usage }
// Heuristic only (NOT a real model): flags text containing "hunter2"/"password"/"secret"
// as credential, and "ignore previous"/"exfiltrate"/"reveal" as unauthorized access.
// Usage: node scripts/mock-jev-server.js [port]   (default 8090)
const http = require("node:http");
const port = Number(process.argv[2] || 8090);

const CRED = /(hunter2|password|passwd|secret|api[_-]?key|token)\s*[:=]/i;
const ATTACK = /(ignore (all )?previous|exfiltrate|reveal (the )?(system|secret)|cat \.env)/i;

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.end('{"ready":true}'); return; }
  if (req.method !== "POST" || req.url !== "/v1/systemone") { res.statusCode = 404; res.end("{}"); return; }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.statusCode = 400; res.end('{"error":"bad json"}'); return; }
    if (!body.model || body.state === undefined || !body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
      res.statusCode = 400; res.end('{"error":"expected {model,state,questions:{id:{type,instructions}}}"}'); return;
    }
    const text = typeof body.state === "string" ? body.state : JSON.stringify(body.state);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      let p = 0.03;
      if (id === "jev-credential" && CRED.test(text)) p = 0.96;
      if (id === "jev-unauthorized-access" && ATTACK.test(text)) p = 0.94;
      answers[id] = { type: q.type, noul: p };
    }
    console.log(`[mock-jev] auth=${req.headers.authorization ? "yes" : "no"} model=${body.model} -> ${JSON.stringify(answers)}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: text.length, output_tokens: 0 } }));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock JEV listening on http://127.0.0.1:${port}/v1/systemone`));
