// Evolution API FALSA (porta 3901): registra o que o PAINEL envia por ela (ex.: o TECH_ERROR do release, CA-31).
// O workflow n8n não passa por aqui (o `engine.mjs` captura o `sendText` do workflow em memória).
//   POST /message/sendText/:instance  { number, text }  -> 201 { key: { id } }   (registra)
//   GET  /__sent                       -> [{ instance, number, text, at }]
//   DELETE /__sent                     -> limpa
//   qualquer outra rota                -> 200 {}
// Uso avulso: node scripts/bot-sim/fake-evolution.mjs   (porta BOTSIM_EVOLUTION_PORT, padrão 3901)
// Os cenários (`scenarios-v2.mjs`) sobem uma instância em processo sozinhos se a porta estiver livre.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const FAKE_EVOLUTION_PORT = Number(process.env.BOTSIM_EVOLUTION_PORT || 3901);
export const FAKE_EVOLUTION_URL = `http://127.0.0.1:${FAKE_EVOLUTION_PORT}`;

export function startFakeEvolution(port = FAKE_EVOLUTION_PORT) {
  const sent = [];
  let seq = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url || "/", "http://x");
      if (url.pathname === "/__sent") {
        if (req.method === "DELETE") { sent.length = 0; return json(200, { ok: true }); }
        return json(200, sent);
      }
      const m = url.pathname.match(/^\/message\/sendText\/([^/]+)$/);
      if (m && req.method === "POST") {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
        sent.push({ instance: decodeURIComponent(m[1]), number: String(body.number ?? ""), text: String(body.text ?? ""), at: new Date().toISOString() });
        return json(201, { key: { id: `FAKEEVO${++seq}` } });
      }
      return json(200, {});
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, sent, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

/** Lê o que o servidor (qualquer processo) na porta registrou. */
export async function fakeSent(url = FAKE_EVOLUTION_URL) {
  const r = await fetch(`${url}/__sent`);
  return r.json();
}
export async function clearFakeSent(url = FAKE_EVOLUTION_URL) {
  await fetch(`${url}/__sent`, { method: "DELETE" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startFakeEvolution();
  console.log(`fake-evolution em ${FAKE_EVOLUTION_URL} (Ctrl+C para sair)`);
}
