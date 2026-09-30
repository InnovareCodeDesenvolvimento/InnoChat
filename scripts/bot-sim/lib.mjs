// Infra compartilhada dos cenários: engine + mundo + seed + helpers de conversa/DB.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.mjs";
import { World, Chat } from "./chat.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const seed = JSON.parse(readFileSync(join(here, ".seed.json"), "utf8"));
export const PANEL = process.env.BOTSIM_PANEL || "http://localhost:3900";
export const API = `${PANEL}/api/internal/v1`;
export const REPO = join(here, "../..");

/** Mundo (engine + contador). `workflowPath` opcional: outro JSON de workflow (padrão: BOTSIM_WORKFLOW ou n8n/innochat-bot.json). */
export function makeWorld(workflowPath) {
  const engine = new Engine({ workflowPath: workflowPath || process.env.BOTSIM_WORKFLOW || join(REPO, "n8n/innochat-bot.json"), painelUrl: API, secret: seed.secret });
  return new World(engine);
}

let prismaP;
/** Prisma para arrumar estado (envelhecer sessão, bloqueios, pausar bot). Lazy: só importa se usado. */
export async function db() {
  if (!prismaP) {
    const { PrismaClient } = await import("@prisma/client");
    prismaP = new PrismaClient();
  }
  return prismaP;
}
export async function closeDb() { if (prismaP) await prismaP.$disconnect(); }

/** SQL cru (independe do Prisma Client conhecer as colunas/tabelas do v2). Devolve linhas (SELECT) ou o nº de afetadas. */
export async function sql(text, ...params) {
  const p = await db();
  return /^\s*select|^\s*with/i.test(text) ? p.$queryRawUnsafe(text, ...params) : p.$executeRawUnsafe(text, ...params);
}
/** Ajusta colunas do tenant por SQL (ex.: { maxFutureAppointmentsPerContact: 0 }). Lança se a coluna não existir (= C-1 pendente). */
export async function setTenant(tenantKey, cols) {
  const entries = Object.entries(cols);
  for (const [k] of entries) if (!/^[A-Za-z]+$/.test(k)) throw new Error(`coluna inválida ${k}`);
  const set = entries.map(([k], i) => `"${k}" = $${i + 2}`).join(", ");
  await sql(`UPDATE tenants SET ${set} WHERE id = $1`, seed.tenants[tenantKey].tenantId, ...entries.map(([, v]) => v));
}
export async function getTenant(tenantKey) {
  const rows = await sql(`SELECT * FROM tenants WHERE id = $1`, seed.tenants[tenantKey].tenantId);
  return rows[0];
}

export const RUN = String(Date.now()).slice(-7);
let phoneSeq = 0;
/** Telefone único por execução/cenário (o banco persiste entre execuções). */
export const newPhone = () => `55119${RUN}${String(++phoneSeq).padStart(2, "0")}`.slice(0, 15);

/** Chamada crua à API interna (para montar estado: ocupar horário etc.). `extra`: cabeçalhos (ex.: { "x-innochat-flow": "2" }). */
export async function api(tenantKey, method, path, body, extra = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${seed.secret}`, "x-innochat-instance": seed.tenants[tenantKey].token, "content-type": "application/json", ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  return { status: res.status, body: json };
}
/** Idem, já com `X-InnoChat-Flow: 2` (o que o workflow v2 envia em todos os nós HTTP). */
export const api2 = (tenantKey, method, path, body) => api(tenantKey, method, path, body, { "x-innochat-flow": "2" });

/**
 * Extrai as opções da última mensagem do bot: `1. Título` (v1) ou `1️⃣ Título` (v2, keycap).
 * `label` = o resto da linha (no v2 inclui o detalhe: "Corte — _1h · R$ 80,00_").
 */
export function parseOptions(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^(\d+)\. (.+)$/) || line.match(/^([0-9])️?⃣ (.+)$/);
    if (m && Number(m[1]) > 0) out.push({ n: Number(m[1]), label: m[2] });
  }
  return out;
}
/** True se a linha usa keycap (v2). */
export const hasKeycap = (text) => /^[0-9]️?⃣ /m.test(String(text || ""));

export class Convo extends Chat {
  constructor(world, tenantKey, phone, opts) {
    super(world, seed.tenants[tenantKey].token, phone, opts);
    this.tenantKey = tenantKey;
    this.last = "";
  }
  /** Como Chat.say, e ainda: `text` (todas as mensagens juntas) e `calls` (chamadas HTTP ao painel feitas nesta execução; só confiável em uso sequencial). */
  async say(text, o) {
    const from = this.world.engine.httpLog.length;
    const r = await super.say(text, o);
    r.text = r.msgs.join("\n");
    r.calls = this.world.engine.httpLog.slice(from);
    if (r.msgs.length) this.last = r.msgs[r.msgs.length - 1];
    return r;
  }
  /** Escolhe pelo rótulo (regex) na última mensagem, respondendo com o número. */
  async pick(re, o) {
    const opt = parseOptions(this.last).find((x) => re.test(x.label));
    if (!opt) throw new Error(`opção ${re} não encontrada em:\n${this.last}`);
    return this.say(String(opt.n), o);
  }
  async contactId() {
    const p = await db();
    const t = seed.tenants[this.tenantKey];
    const c = await p.contact.findFirst({ where: { tenantId: t.tenantId, waJid: this.jid } });
    return c?.id;
  }
  async contactRow() {
    const p = await db();
    return p.contact.findFirst({ where: { tenantId: seed.tenants[this.tenantKey].tenantId, waJid: this.jid } });
  }
  async sessionRow() {
    const p = await db();
    return p.chatSession.findFirst({ where: { contactId: await this.contactId() } });
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- datas no fuso do tenant (Intl; o simulador roda em Node)
export const TZ = { bela: "America/Sao_Paulo", dupla: "America/Sao_Paulo", grade: "America/Sao_Paulo", limite: "America/Sao_Paulo", especial: "America/Sao_Paulo", equipe: "America/Sao_Paulo", menuedit: "America/Sao_Paulo", menuport: "America/Sao_Paulo", semagenda: "America/Sao_Paulo", vazio: "America/Sao_Paulo", solo: "America/Manaus", tokyo: "Asia/Tokyo", honolulu: "Pacific/Honolulu", kiribati: "Pacific/Kiritimati" };
/** YYYY-MM-DD do instante `d` no fuso `tz`. */
export const localISO = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** HH:mm do instante `d` no fuso `tz`. */
export const localHM = (d, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
export const addDaysISO = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** 0 = domingo. */
export const weekdayOfISO = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
/** "02/10" */
export const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const WEEKDAY_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
