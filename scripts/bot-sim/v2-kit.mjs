// Kit dos cenários do bot v2 (I-1): registro de cenários, checagens atribuídas a tarefas, condutores de conversa,
// padrões dos textos v2 (spec §5.3) e utilitários de banco/relógio. Usado por scenarios-v2.mjs e scenarios-v2-api.mjs.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, REPO, Convo, newPhone, db, sql, setTenant, getTenant, api, api2, parseOptions, hasKeycap, seed, sleep, TZ, localISO, localHM, addDaysISO, weekdayOfISO, ddmm } from "./lib.mjs";
import { startFakeEvolution, fakeSent, clearFakeSent, FAKE_EVOLUTION_URL } from "./fake-evolution.mjs";

export { db, sql, setTenant, getTenant, api, api2, parseOptions, hasKeycap, seed, sleep, TZ, localISO, localHM, addDaysISO, weekdayOfISO, ddmm, newPhone, Convo, makeWorld };

export const world = makeWorld();
/** JSON.stringify que nunca devolve undefined (para montar mensagens de verificação). */
export const J = (v) => String(JSON.stringify(v));
/** setTenant que devolve o motivo em vez de lançar (coluna/CHECK do v2 ainda não existe = C-1 pendente). */
export async function trySetTenant(key, cols) {
  try { await setTenant(key, cols); return null; } catch (e) { return String((e && e.message) || e).split(String.fromCharCode(10)).filter(Boolean).pop().slice(0, 160); }
}

// ---------------------------------------------------------------- registro
export const scenarios = [];
export const state = { cur: null, results: [] };
/**
 * `task` = tarefa do plano que deixa o cenário verde: B-1 (catálogo/disponibilidade/agendamentos), B-2 (claim/sessão/atendente/release),
 * B-3 (textos por versão), C-1 (dados), W-1 (workflow + motor A-2 embutido), D-1 (publicar). `check(..., task)` sobrescreve por verificação.
 */
export function scenario(id, title, task, fn) { scenarios.push({ id, title, task, fn }); }
/** Critério coberto FORA do simulador (E2E do navegador / teste unitário): aparece no relatório como EXTERNO, sem contar verde nem vermelho. */
export function external(id, title, where) { scenarios.push({ id, title, external: where }); }
export function check(cond, msg, task) { state.cur.checks.push({ ok: !!cond, msg, task: task || state.cur.task }); }
/** Roda um sub-caso; exceção (opção não encontrada, tela inesperada...) vira uma verificação vermelha em vez de derrubar o cenário. */
export async function sub(label, fn, task) {
  try { await fn(); } catch (e) { check(false, `${label}: ${String((e && e.message) || e).split(/\r?\n/).slice(0, 5).join(" | ").slice(0, 300)}`, task); }
}
export const conv = (tenant = "dupla", o) => { const c = new Convo(world, tenant, newPhone(), o); state.cur.convos.push(c); return c; };
/** Nova conversa com telefone dado (cliente fixo do seed). */
export const convPhone = (tenant, phone, o) => { const c = new Convo(world, tenant, phone, o); state.cur.convos.push(c); return c; };

// ---------------------------------------------------------------- padrões dos textos padrão v2 (spec §5.3)
export const T = {
  GREETING: /Aqui é a/,
  MENU_HINT: /responder com o número ou o nome da opção/,
  FOOTER_HINT: /Digite \*?0\*? para o menu/,
  CHOOSE_SERVICE: /Qual serviço você quer marcar/,
  NO_SERVICES: /Não tem nenhum serviço pra marcar/,
  CHOOSE_PROFESSIONAL: /Com quem você prefere marcar/,
  CHOOSE_DAY: /Para qual dia\?/,
  NEXT_AVAILABLE: /Próximos horários livres/,
  CHOOSE_TIME: /Horários livres em/,
  NO_SLOTS_DAY: /Não tem horário livre em/,
  DATE_OUT_OF_RANGE: /Só consigo marcar de hoje até/,
  TIME_NOT_AVAILABLE: /não tem vaga em/,
  NO_AVAILABILITY: /Não tem horário livre para/,
  ITEM_UNAVAILABLE: /não está mais disponível/,
  APPOINTMENT_LIMIT: /Você já tem \*?\d+\*? agendamentos marcados/,
  ASK_NAME: /qual é o seu nome/i,
  NAME_INVALID: /Não consegui anotar esse nome/,
  NAME_TOO_LONG: /ficou um pouco longo/,
  CONFIRM_SUMMARY: /Confira o seu agendamento/,
  CONFIRM_RESCHEDULE: /Sua remarcação/,
  CONFIRM_EDIT: /O que você quer corrigir/,
  BOOKED: /Agendamento confirmado/,
  SLOT_TAKEN: /acabou de pegar o horário/,
  POST_ACTION_MENU: /Posso ajudar em algo mais/,
  MY_APPOINTMENTS: /Seus próximos agendamentos/,
  NO_APPOINTMENTS: /não tem nenhum agendamento marcado/,
  APPOINTMENT_DETAIL: /O que você quer fazer/,
  APPOINTMENT_LOCKED: /Por aqui dá pra mudar até/,
  CONFIRM_CANCEL: /Quer mesmo \*?cancelar/,
  CANCELED: /foi \*?cancelado/,
  CANCEL_KEPT: /continua marcado/,
  RESCHEDULED: /Agendamento remarcado/,
  TOO_LATE: /não dá mais pra mudar por aqui/,
  HUMAN_HANDOFF: /Já avisei a equipe/,
  HUMAN_HANDOFF_OFF_HOURS: /fora do horário de atendimento/,
  BOT_RESUMED: /voltei a atender por aqui/,
  INVALID_OPTION: /Não entendi\. Responda/,
  INVALID_BACK_TO_MENU: /Vamos recomeçar pelo menu/,
  AMBIGUOUS_OPTION: /mais de uma opção parecida/,
  ONLY_TEXT: /só entendo mensagem escrita/,
  RESUME_OFFER: /Oi de novo/,
  THANKS_REPLY: /Por nada/,
  GOODBYE: /Atendimento encerrado/,
  TECH_ERROR: /Deu um problema aqui/,
  HELP: /Como usar o atendimento/,
  CONTINUE_PROMPT: /Continuando de onde paramos/,
  SESSION_EXPIRED: /faz um tempinho/i,
};

// Modo de fumaça (só para exercitar o código dos cenários contra o fluxo v1, que fala outro texto): BOTSIM_V1_PHRASES=1.
// Não tem valor de veredito: o v1 não implementa o que os cenários cobram.
if (process.env.BOTSIM_V1_PHRASES === "1") {
  Object.assign(T, {
    CHOOSE_SERVICE: /Qual serviço você (deseja|quer) agendar/,
    CHOOSE_TIME: /Horários livres em|Escolha um horário/,
    CONFIRM_SUMMARY: /Confira os dados do agendamento|Confirma o agendamento/,
    NO_APPOINTMENTS: /não tem agendamentos (futuros|marcados)/,
    APPOINTMENT_DETAIL: /O que você deseja fazer|O que deseja fazer/,
    CONFIRM_CANCEL: /Tem certeza de que deseja *?cancelar|Confirma o cancelamento/,
    MY_APPOINTMENTS: /Seus próximos agendamentos|Seus agendamentos/,
  });
}

// ---------------------------------------------------------------- leitura de mensagens
export const opts = (c) => parseOptions(c.last);
export const dayOpts = (text) => parseOptions(text).filter((o) => /\d\d\/\d\d/.test(o.label) && !/Ver mais|anteriores/i.test(o.label) && !/^\d\d:\d\d/.test(o.label.trim()));
export const timeOpts = (text) => parseOptions(text).filter((o) => /^\d\d:\d\d$/.test(o.label.trim()));
export const labelOf = (o) => o.label.replace(/\s+—.*$/, "").trim();
export const firstLine = (t) => String(t || "(nada)").split("\n").filter(Boolean)[0] || "(vazio)";
export const brief = (t) => String(t || "(nada)").split("\n").filter(Boolean).slice(0, 3).join(" / ").slice(0, 200);
export const norm = (s) => String(s || "").replace(/\u00a0/g, " ");

/** Envia e devolve { msgs, text (todas as mensagens juntas), calls (chamadas HTTP ao painel feitas nesta execução), ... }. Só para uso sequencial. */
export async function say(c, text, o) {
  const from = world.engine.httpLog.length;
  const r = await c.say(text, o);
  r.calls = world.engine.httpLog.slice(from);
  r.text = r.msgs.join("\n");
  return r;
}
export async function sessionOf(c) { return c.sessionRow(); }
export async function ctxOf(c) { const s = await c.sessionRow(); return (s && s.context) || {}; }

// ---------------------------------------------------------------- condutores de conversa (v2)
/** "oi" (+ opcionalmente já grava o nome do cliente para pular o ASK_NAME). */
export async function start(c, { named = false } = {}) {
  const r = await say(c, "oi");
  if (named) {
    const cid = await c.contactId();
    await api(c.tenantKey, "PATCH", `/contacts/${cid}`, { name: typeof named === "string" ? named : "Cliente Nomeado" });
  }
  return r;
}
/** Do menu até o serviço/profissional; devolve com o passo "Para qual dia?" na tela. */
export async function toDay(c, { service = /Corte/, pro = /Ana/ } = {}) {
  await c.pick(/Agendar/);
  if (T.CHOOSE_SERVICE.test(c.last)) await c.pick(service);
  if (T.CHOOSE_PROFESSIONAL.test(c.last)) await c.pick(pro);
  if (!T.CHOOSE_DAY.test(c.last)) throw new Error(`esperava "Para qual dia?" e veio:\n${c.last}`);
}
/** Escolhe o dia `day` (0 = primeiro dia da lista, sem contar "Primeiro horário livre") → tela de horários. */
export async function toTime(c, o = {}) {
  await toDay(c, o);
  const d = dayOpts(c.last)[o.day ?? 1];
  if (!d) throw new Error(`sem dia #${o.day ?? 1} na lista:\n${c.last}`);
  await say(c, String(d.n));
  if (!T.CHOOSE_TIME.test(c.last)) throw new Error(`esperava a lista de horários e veio:\n${c.last}`);
}
/** Escolhe o horário `time` (índice) → tela de nome ou de confirmação. */
export async function toAfterTime(c, o = {}) {
  await toTime(c, o);
  const t = timeOpts(c.last)[o.time ?? 0];
  if (!t) throw new Error(`sem horário #${o.time ?? 0}:\n${c.last}`);
  return say(c, String(t.n));
}
/** Até a tela de confirmação (digita o nome se for pedido). */
export async function toConfirm(c, o = {}) {
  await toAfterTime(c, o);
  if (T.ASK_NAME.test(c.last)) await say(c, o.name || "Cliente Teste");
  if (!T.CONFIRM_SUMMARY.test(c.last)) throw new Error(`esperava a confirmação e veio:\n${c.last}`);
}
/** Já na tela "Para qual dia?": escolhe o dia e o horário; digita o nome se pedido; para na confirmação. */
export async function fromDay(c, { day = 1, time = 0, name } = {}) {
  const d = dayOpts(c.last)[day];
  if (!d) throw new Error(`sem dia #${day}:
${c.last}`);
  await say(c, String(d.n));
  const t = timeOpts(c.last)[time];
  if (!t) throw new Error(`sem horário #${time}:
${c.last}`);
  await say(c, String(t.n));
  if (T.ASK_NAME.test(c.last)) await say(c, name || "Cliente Teste");
}
/** Do zero até a reserva feita (BOOKED). `named`: pula o nome. */
export async function book(c, o = {}) {
  await start(c, { named: o.named ?? true });
  await toConfirm(c, o);
  return c.pick(/Confirmar/);
}

// ---------------------------------------------------------------- banco: sessão, atendente, relógio
export const S = (tenantKey) => seed.tenants[tenantKey];
export async function handoffs(contactId) {
  try {
    return await sql(`SELECT id, reason::text AS reason, "offHours", "requestedAt", "answeredAt", "endedAt", "endReason"::text AS "endReason" FROM handoff_requests WHERE "contactId" = $1 ORDER BY "requestedAt"`, contactId);
  } catch (e) {
    return null; // tabela inexistente (C-1 pendente)
  }
}
/** Envelhece a sessão: como se a última mensagem do cliente tivesse sido há `minutes`. */
export async function ageSession(c, minutes) {
  await sql(`UPDATE chat_sessions SET "lastInboundAt" = (now() at time zone 'utc') - ($2 || ' minutes')::interval WHERE "contactId" = $1`, await c.contactId(), String(minutes));
}
export async function setHumanUntil(c, minutesFromNow) {
  await sql(`UPDATE chat_sessions SET "humanUntil" = (now() at time zone 'utc') + ($2 || ' minutes')::interval WHERE "contactId" = $1`, await c.contactId(), String(minutesFromNow));
}
/** Grava o expediente da equipe do tenant (todas as datas 00:00-23:59 = aberto agora; ou só amanhã 09-18 = fechado agora). */
export async function setTeamHours(tenantKey, mode) {
  const p = await db();
  const t = S(tenantKey);
  const proId = Object.values(t.pros)[0];
  await p.workingHour.deleteMany({ where: { professionalId: proId } });
  if (mode === "open") {
    await p.workingHour.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ professionalId: proId, weekday, startTime: "00:00", endTime: "23:59" })) });
  } else {
    const tomorrow = addDaysISO(localISO(new Date(), TZ[tenantKey]), 1);
    await p.workingHour.create({ data: { professionalId: proId, weekday: weekdayOfISO(tomorrow), startTime: "09:00", endTime: "18:00" } });
  }
}
/** Horário livre da agenda de `proKey` em `dayOffset` dias (1º da lista), via API. Devolve { iso, date }. */
export async function freeSlot(tenantKey, serviceId, professionalId, dayOffset) {
  const tz = TZ[tenantKey];
  const date = addDaysISO(localISO(new Date(), tz), dayOffset);
  const r = await api(tenantKey, "GET", `/availability/slots?serviceId=${serviceId}&professionalId=${professionalId}&date=${date}&offset=0&limit=1`);
  if (!r.body?.options?.length) throw new Error(`sem horário livre em ${date} (${tenantKey}): ${JSON.stringify(r.body)}`);
  return { iso: r.body.options[0].id, date };
}
/** Todos os horários do dia (pagina de 8 em 8). Devolve [{ id, label }]. */
export async function allSlots(tenantKey, serviceId, professionalId, date, extra = "") {
  const out = [];
  for (let offset = 0, i = 0; i < 8; i++, offset += 8) {
    const r = await api(tenantKey, "GET", `/availability/slots?serviceId=${serviceId}&${professionalId ? `professionalId=${professionalId}&` : ""}date=${date}&offset=${offset}&limit=8${extra}`);
    out.push(...(r.body?.options || []));
    if (!r.body?.hasMore) break;
  }
  return out;
}
/** Cria agendamento direto pela API (sem o header do fluxo v2, ou com). */
export async function createAppt(tenantKey, { contactId, serviceId, professionalId, startsAt, key, flow2 = false, contactName }) {
  const body = { contactId, serviceId, professionalId, startsAt, idempotencyKey: key };
  if (contactName) body.contactName = contactName;
  return (flow2 ? api2 : api)(tenantKey, "POST", "/appointments", body);
}

// ---------------------------------------------------------------- Evolution falsa (o que o PAINEL envia)
let fake = null;
/** Sobe a Evolution falsa em processo se a porta estiver livre; senão usa a que já roda. */
export async function ensureFake() {
  if (fake) return fake;
  try {
    await fakeSent();
    fake = { external: true };
  } catch {
    try { fake = { ...(await startFakeEvolution()), external: false }; }
    catch (e) { throw new Error(`Evolution falsa: porta ocupada por algo que não é ela (${e.code || e.message})`); }
  }
  return fake;
}
export async function closeFake() { if (fake && !fake.external) await fake.close(); fake = null; }
export { fakeSent, clearFakeSent, FAKE_EVOLUTION_URL };

// ---------------------------------------------------------------- formatação de data como o painel (formatWhenLabel, plano §3.3)
const WD_ABBR = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
export function whenLabel(at, now, tz) {
  const hm = localHM(at, tz);
  const d = localISO(at, tz);
  const today = localISO(now, tz);
  if (d === today) return `hoje às ${hm}`;
  if (d === addDaysISO(today, 1)) return `amanhã às ${hm}`;
  return `${WD_ABBR[weekdayOfISO(d)]} ${ddmm(d)} às ${hm}`;
}
/** Aceita ±90 s de diferença entre o relógio do painel e o do simulador. */
export function whenLabelsAround(target, tz) {
  const out = new Set();
  for (const off of [-90, -60, -30, 0, 30, 60, 90]) out.add(whenLabel(new Date(target.getTime() + off * 1000), new Date(), tz));
  return [...out];
}

// ---------------------------------------------------------------- lint de mensagens (CA-38, CA-39, CA-41)
export function lintMessage(m) {
  const errs = [];
  const lit = m.match(/\{[A-Za-z_]+\}/g);
  if (lit) errs.push(`variável literal ${lit.join(",")}`);
  if (/\n[ \t]*\n[ \t]*\n/.test(m)) errs.push("2 linhas em branco seguidas");
  if (/, !/.test(m)) errs.push('", !"');
  if (/(Olá|Oi), ?[!.]/.test(m)) errs.push('"Oi, !"');
  if (/\bundefined\b|\bnull\b|\[object /.test(m)) errs.push("undefined/null literal");
  const lines = m.split(/\r?\n/);
  const plain = lines.filter((l) => /^\d+\. \S/.test(l));
  const keycap = lines.filter((l) => /^[0-9]\uFE0F?\u20E3 /.test(l));
  if (plain.length && keycap.length === 0 && !/^0\. /m.test(m)) errs.push("opções sem keycap (1. em vez de 1️⃣)");
  if (keycap.length) {
    const last = lines.filter((l) => l.trim()).pop() || "";
    if (!(T.FOOTER_HINT.test(last) || T.MENU_HINT.test(last))) errs.push(`mensagem com opções não termina com FOOTER_HINT/MENU_HINT (termina com: "${last.slice(0, 60)}")`);
  }
  return errs;
}

/** Divide um .sql em comandos respeitando $$...$$, aspas simples e comentários de linha. */
export function splitSql(src) {
  const out = [];
  let cur = "";
  let i = 0;
  let dollar = null;
  let quote = false;
  while (i < src.length) {
    const rest = src.slice(i);
    if (!dollar && !quote && rest.startsWith("--")) { const nl = rest.indexOf("\n"); i += nl === -1 ? rest.length : nl; continue; }
    if (!quote) {
      const m = rest.match(/^\$[A-Za-z_]*\$/);
      if (m) { if (!dollar) dollar = m[0]; else if (dollar === m[0]) dollar = null; cur += m[0]; i += m[0].length; continue; }
    }
    if (!dollar && src[i] === "'") quote = !quote;
    if (!dollar && !quote && src[i] === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; i++; continue; }
    cur += src[i++];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Roda a migration *_bot_v2_port_texts (idempotente) no banco do simulador. Devolve null se ok, ou o motivo. */
export async function runPortMigration() {
  const dirs = readdirSync(join(REPO, "prisma", "migrations")).filter((d) => /bot_v2_port_texts/.test(d));
  if (!dirs.length) return "a migration *_bot_v2_port_texts ainda não existe (C-1)";
  const text = readFileSync(join(REPO, "prisma", "migrations", dirs[0], "migration.sql"), "utf8");
  try { for (const stmt of splitSql(text)) await sql(stmt); return null; }
  catch (e) { return `a migration de porte falhou: ${String(e.message).split(/\r?\n/).slice(-2).join(" ").slice(0, 250)}`; }
}
