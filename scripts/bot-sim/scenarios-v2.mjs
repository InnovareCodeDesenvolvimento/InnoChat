// Cenários do bot v2: um por critério de aceite (CA-01..CA-47, spec §10) e os de API (API-01..API-13, plano §4/I-1).
// Uso: node scripts/bot-sim/withdb.mjs node scripts/bot-sim/scenarios-v2.mjs [filtro-regex-de-id]
//   BOTSIM_WORKFLOW  workflow a executar (padrão: n8n/innochat-bot.json = o v2 depois da W-1)
//   BOTSIM_SKIP_CA45=1  pula o CA-45 (roda de novo os 61 cenários da auditoria com o fluxo v1; leva alguns minutos)
// Escritos contra os contratos do plano §3 ANTES do código existir: enquanto B-1/B-2/B-3/C-1/W-1 não entram, ficam VERMELHOS
// de propósito. Cada verificação carrega a tarefa que a deixa verde; o resumo agrupa os vermelhos por tarefa.
// Códigos de saída: 0 tudo verde · 1 há vermelhos · 2 problema de infraestrutura (painel fora, seed velho).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- seed limpo a cada rodada
// Alguns cenários (ex.: CA-19) deixam agendamentos/estado no banco; sem recriar o seed a rodada seguinte
// falha por dado sujo, não por bug. O seed é idempotente (apaga os `botsim-*` e recria, com tokens novos),
// por isso roda ANTES de qualquer import que leia `.seed.json`. `BOTSIM_NO_RESEED=1` pula (depuração).
if (process.env.BOTSIM_NO_RESEED !== "1") {
  const r = spawnSync(process.execPath, [join(here, "seed.mjs")], { encoding: "utf8", env: process.env });
  if (r.status !== 0) {
    const tail = String(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-6).join(" | ");
    console.error(`INFRA: o seed falhou (código ${r.status}). ${tail}`);
    process.exit(2);
  }
}
const { scenarios, state, world, seed, api, closeFake, S } = await import("./v2-kit.mjs");
const { closeDb } = await import("./lib.mjs");

// ---------------------------------------------------------------- pré-condições (infra, não é vermelho de produto)
for (const k of ["dupla", "grade", "limite", "especial", "equipe", "menuedit", "menuport", "semagenda"]) {
  if (!seed.tenants[k]) { console.error(`INFRA: o seed não tem o tenant "${k}". Rode: node scripts/bot-sim/withdb.mjs node scripts/bot-sim/seed.mjs`); process.exit(2); }
}
try {
  const r = await api("dupla", "GET", "/catalog/services");
  if (r.status !== 200) throw new Error(`GET /catalog/services → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
} catch (e) {
  console.error(`INFRA: o painel não respondeu como esperado em ${process.env.BOTSIM_PANEL || "http://localhost:3900"} (${e.message}). Suba o painel (README) e refaça o seed.`);
  process.exit(2);
}

await import("./scenarios-v2-a.mjs");
await import("./scenarios-v2-b.mjs");
await import("./scenarios-v2-api.mjs");
await import("./scenarios-v2-waitlist.mjs");

// ordem: CA-01.. , CA-47, depois API-01.. (o CA-38/39/41 varrem as mensagens dos anteriores, então ficam depois de tudo que conversa)
const order = (s) => (/^CA-(38|39|41)$/.test(s.id) ? 1000 + Number(s.id.slice(3)) : /^CA-45$/.test(s.id) ? 2000 : /^API-/.test(s.id) ? 500 + Number(s.id.slice(4)) : /^WL-/.test(s.id) ? 600 + Number(s.id.slice(3)) : Number(s.id.slice(3)));
scenarios.sort((a, b) => order(a) - order(b));

const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
const started = Date.now();
let md = `# Transcrições do simulador v2 — ${new Date().toISOString()}\n\nWorkflow: ${process.env.BOTSIM_WORKFLOW || "n8n/innochat-bot.json"}\n`;
const cut = (s, n = 230) => (String(s).length > n ? String(s).slice(0, n) + "…" : String(s));

for (const s of scenarios) {
  if (filter && !filter.test(s.id)) continue;
  if (s.external) {
    console.log(`EXT   ${s.id} ${s.title}\n      ↳ coberto por: ${s.external}`);
    state.results.push({ id: s.id, title: s.title, external: s.external, checks: [], convos: [] });
    continue;
  }
  state.cur = { id: s.id, title: s.title, task: s.task, checks: [], convos: [] };
  let crash = null;
  const t0 = Date.now();
  try { await s.fn(); } catch (e) { crash = e; }
  const cur = state.cur;
  state.results.push({ ...cur, crash });
  const fails = cur.checks.filter((c) => !c.ok);
  const status = crash ? "CRASH" : fails.length ? "FALHA" : "ok   ";
  console.log(`${status} ${s.id} [${s.task}] ${s.title} (${cur.checks.length - fails.length}/${cur.checks.length} verificações, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const f of fails) console.log(`      x [${f.task}] ${cut(f.msg)}`);
  if (crash) console.log(`      ! ${cut(String(crash.stack || crash.message).split("\n").slice(0, 4).join(" | "), 400)}`);
  md += `\n\n## ${s.id} [${s.task}] — ${s.title}\n` + cur.checks.map((c) => `- ${c.ok ? "OK    " : "FALHOU"} [${c.task}]: ${c.msg}`).join("\n") + (crash ? `\n- CRASH: ${crash.message}` : "") + cur.convos.map((c, i) => c.transcript(`conversa ${i + 1} (${c.tenantKey} ${c.phone})`)).join("\n");
}

// ---------------------------------------------------------------- resumo agrupado por tarefa
const ran = state.results.filter((r) => !r.external);
const red = ran.filter((r) => r.crash || r.checks.some((c) => !c.ok));
// Exceção no meio do cenário = a conversa não chegou à tela esperada (fluxo/textos: W-1); erro de SQL/Prisma = dado do v2 ausente (C-1).
const crashTask = (r) => (/Raw query failed|PrismaClient|does not exist|não existe/i.test(String(r.crash && r.crash.message)) ? "C-1" : "W-1");
const byTask = {};
for (const r of red) {
  const tasks = new Set(r.checks.filter((c) => !c.ok).map((c) => c.task));
  if (r.crash) tasks.add(crashTask(r));
  for (const t of tasks) {
    const fails = r.checks.filter((c) => !c.ok && c.task === t);
    (byTask[t] ||= []).push({ id: r.id, n: fails.length + (r.crash && crashTask(r) === t ? 1 : 0), first: fails[0] ? fails[0].msg : `CRASH: ${r.crash && r.crash.message}` });
  }
}
let summary = `\n${"=".repeat(78)}\nRESUMO v2: ${ran.length} cenários rodados, ${ran.length - red.length} verdes, ${red.length} vermelhos, ${state.results.length - ran.length} externos (${((Date.now() - started) / 1000).toFixed(0)}s)\n`;
summary += `Vermelhos por tarefa que os deixa verdes (um cenário pode aparecer em mais de uma):\n`;
for (const t of Object.keys(byTask).sort()) summary += `  ${t.padEnd(4)} ${byTask[t].length} cenário(s): ${byTask[t].map((x) => `${x.id}(${x.n})`).join(", ")}\n`;
console.log(summary);
mkdirSync(join(here, "out"), { recursive: true });
writeFileSync(join(here, "out", "transcripts-v2.md"), md);
let red_md = `# Vermelhos do v2 por tarefa — ${new Date().toISOString()}\n\n` + Object.keys(byTask).sort().map((t) => `## ${t}\n` + byTask[t].map((x) => `- **${x.id}** (${x.n} verificação(ões)): ${cut(x.first, 300)}`).join("\n")).join("\n\n") + "\n";
writeFileSync(join(here, "out", "vermelhos-v2.md"), red_md);
console.log("Transcrições: scripts/bot-sim/out/transcripts-v2.md · Vermelhos por tarefa: scripts/bot-sim/out/vermelhos-v2.md");
await closeFake();
await closeDb();
process.exit(red.length ? 1 : 0);
