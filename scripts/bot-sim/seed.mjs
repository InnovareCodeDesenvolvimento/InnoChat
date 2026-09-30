// Semeia os tenants do simulador do bot no banco apontado por DATABASE_URL (use o banco DEDICADO innochat_botsim).
// Uso: node scripts/bot-sim/withdb.mjs node scripts/bot-sim/seed.mjs
// Idempotente: apaga os tenants `botsim-*` e recria. Escreve scripts/bot-sim/.seed.json (não versionado).
//
// Nada aqui depende de colunas/enum do bot v2 (o seed roda antes e depois da C-1): o que é novo do v2
// (maxFutureAppointmentsPerContact, handoffResumeMinutes, MENU_PROMPT...) é ajustado pelos cenários via SQL cru.
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_EVOLUTION_URL } from "./fake-evolution.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
export const INTERNAL_SECRET = "botsim-internal-secret-0123456789";
// Segredos falsos são montados com join (nunca literais completos no código).
const FAKE_EVOLUTION_KEY = ["botsim", "evolution", "fake", "key"].join("-");
const sha = (s) => createHash("sha256").update(s).digest("hex");

const url = process.env.DATABASE_URL ?? "";
if (!/innochat_(test|botsim)/.test(url) && process.env.BOTSIM_ALLOW_ANY_DB !== "1") {
  console.error("Recusando: DATABASE_URL não aponta para innochat_test/innochat_botsim. (BOTSIM_ALLOW_ANY_DB=1 para forçar)");
  process.exit(1);
}

await prisma.tenant.deleteMany({ where: { slug: { startsWith: "botsim-" } } });
await prisma.plan.deleteMany({ where: { code: "botsim-plan" } });
const plan = await prisma.plan.create({ data: { code: "botsim-plan", name: "Plano botsim", priceCents: 0, maxWhatsappNumbers: 5, maxProfessionals: null, active: false, sortOrder: 999 } });
// A Evolution do painel aponta para o servidor falso (fake-evolution.mjs): o release do TECH_ERROR (CA-31) cai lá.
const platform = { internalApiSecretHash: sha(INTERNAL_SECRET), evolutionApiUrl: FAKE_EVOLUTION_URL, evolutionApiKey: FAKE_EVOLUTION_KEY };
await prisma.platformSettings.upsert({ where: { id: 1 }, create: { id: 1, ...platform }, update: platform });

async function mkTenant(key, data) {
  const tenant = await prisma.tenant.create({ data: { slug: `botsim-${key}`, ...data } });
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 90 * 86_400_000) } });
  const token = `botsim-token-${key}-${randomUUID().slice(0, 8)}`;
  const instance = await prisma.whatsappInstance.create({ data: { tenantId: tenant.id, instanceName: `botsim-${key}`, label: "Principal", webhookToken: token, status: "CONNECTED" } });
  return { tenant, instance, token };
}
const svc = (tenantId, name, durationMin, priceCents, sortOrder, extra = {}) => prisma.service.create({ data: { tenantId, name, durationMin, priceCents, sortOrder, ...extra } });
const pro = (tenantId, name, sortOrder, days, from, to) =>
  prisma.professional.create({ data: { tenantId, name, sortOrder, workingHours: { create: days.map((weekday) => ({ weekday, startTime: from, endTime: to })) } } });
const link = (professionalId, serviceIds) => prisma.professionalService.createMany({ data: serviceIds.map((serviceId) => ({ professionalId, serviceId })) });
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const out = {};

// --- Studio Bela: fuso de São Paulo, muitos serviços, 3 profissionais (grade 30, como o padrão do v2) ---
{
  const { tenant, token } = await mkTenant("bela", { name: "Studio Bela", timezone: "America/Sao_Paulo", slotGranularityMin: 30, minLeadTimeMin: 60, maxHorizonDays: 30, cancelMinLeadMin: 120, sessionTimeoutMin: 30, reminderEnabled: false });
  const T = tenant.id;
  const names = [["Corte feminino", 60, 8000], ["Escova", 45, 5000], ["Barba", 30, 3500], ["Coloração", 120, 18000], ["Hidratação", 60, 7000], ["Manicure", 60, 4000], ["Pedicure", 60, 4500], ["Sobrancelha", 30, null], ["Massagem", 60, 12000], ["Depilação", 30, 6000], ["Maquiagem", 60, 15000]];
  const S = {};
  let i = 0;
  for (const [n, d, p] of names) S[n] = await svc(T, n, d, p, i++);
  S["Limpeza de pele"] = await svc(T, "Limpeza de pele", 60, 9000, i++); // sem nenhum profissional
  S["Sem expediente"] = await svc(T, "Sem expediente", 60, 1000, i++); // só a Carla (sem horário de trabalho)
  S["Legado"] = await svc(T, "Legado inativo", 60, 100, i++, { active: false });
  const semBarba = Object.values(S).filter((s) => !["Barba", "Limpeza de pele", "Sem expediente", "Legado inativo"].includes(s.name)).map((s) => s.id);
  const ana = await pro(T, "Ana", 0, [1, 2, 3, 4, 5, 6], "09:00", "18:00");
  const bruno = await pro(T, "Bruno", 1, [2, 3, 4, 5], "10:00", "16:00");
  const carla = await pro(T, "Carla", 2, [], "09:00", "18:00"); // sem expediente
  await pro(T, "Dani (inativa)", 3, [1, 2, 3], "09:00", "18:00").then((d) => prisma.professional.update({ where: { id: d.id }, data: { active: false } }));
  await link(ana.id, semBarba);
  await link(bruno.id, [S["Corte feminino"].id, S["Barba"].id, S["Escova"].id]);
  await link(carla.id, [S["Corte feminino"].id, S["Escova"].id, S["Sem expediente"].id]);
  out.bela = { tenantId: T, token, services: Object.fromEntries(Object.entries(S).map(([k, v]) => [k, v.id])), pros: { ana: ana.id, bruno: bruno.id, carla: carla.id } };
}

// --- Fusos extremos (virada de dia): Tóquio (+9), Honolulu (-10) e Kiritimati (+14: quase sempre 'amanhã' em relação ao UTC) ---
// Grade 30 (o CHECK do v2 só aceita 15 ou 30; a v1 aceitava 60).
for (const [key, tz] of [["tokyo", "Asia/Tokyo"], ["honolulu", "Pacific/Honolulu"], ["kiribati", "Pacific/Kiritimati"]]) {
  const { tenant, token } = await mkTenant(key, { name: `Clínica ${key}`, timezone: tz, slotGranularityMin: 30, minLeadTimeMin: 0, maxHorizonDays: 14, cancelMinLeadMin: 120, reminderEnabled: false });
  const s = await svc(tenant.id, "Consulta", 60, 10000, 0);
  const p = await pro(tenant.id, "Dr. Noite", 0, ALL_DAYS, "08:00", "23:59");
  await link(p.id, [s.id]);
  out[key] = { tenantId: tenant.id, token, services: { Consulta: s.id }, pros: { p: p.id } };
}

// --- Empresa sem serviço nenhum ---
{
  const { tenant, token } = await mkTenant("vazio", { name: "Empresa Vazia", timezone: "America/Sao_Paulo", reminderEnabled: false });
  out.vazio = { tenantId: tenant.id, token };
}

// --- Empresa com serviços, mas NENHUM agendável (o único profissional não tem expediente) → NO_SERVICES (CA-37) ---
{
  const { tenant, token } = await mkTenant("semagenda", { name: "Sem Agenda", timezone: "America/Sao_Paulo", slotGranularityMin: 30, reminderEnabled: false });
  const s = await svc(tenant.id, "Consulta", 60, 10000, 0);
  const p = await pro(tenant.id, "Sem Horário", 0, [], "09:00", "18:00");
  await link(p.id, [s.id]);
  out.semagenda = { tenantId: tenant.id, token, services: { Consulta: s.id }, pros: { p: p.id } };
}

// --- Empresa com 1 só profissional, askProfessional=false, 2 profissionais em outro serviço (grade 15) ---
{
  const { tenant, token } = await mkTenant("solo", { name: "Solo Barbearia", timezone: "America/Manaus", slotGranularityMin: 15, minLeadTimeMin: 0, maxHorizonDays: 60, askProfessional: false, reminderEnabled: false });
  const s = await svc(tenant.id, "Corte", 30, 4000, 0);
  const p1 = await pro(tenant.id, "Zé", 0, [1, 2, 3, 4, 5], "09:00", "12:00");
  const p2 = await pro(tenant.id, "Léo", 1, [1, 2, 3, 4, 5], "14:00", "17:00");
  await link(p1.id, [s.id]); await link(p2.id, [s.id]);
  out.solo = { tenantId: tenant.id, token, services: { Corte: s.id }, pros: { ze: p1.id, leo: p2.id } };
}

// --- (v2) Dupla: 2 serviços, 2 profissionais com expediente todos os dias 09-18 (concorrência, corrigir profissional, remarcar) ---
{
  const { tenant, token } = await mkTenant("dupla", { name: "Dupla Salão", timezone: "America/Sao_Paulo", slotGranularityMin: 30, minLeadTimeMin: 60, maxHorizonDays: 30, cancelMinLeadMin: 120, sessionTimeoutMin: 30, reminderEnabled: false });
  const corte = await svc(tenant.id, "Corte", 60, 5000, 0);
  const barba = await svc(tenant.id, "Barba", 30, null, 1);
  const ana = await pro(tenant.id, "Ana", 0, ALL_DAYS, "09:00", "18:00");
  const julia = await pro(tenant.id, "Júlia", 1, ALL_DAYS, "09:00", "18:00");
  await link(ana.id, [corte.id, barba.id]); await link(julia.id, [corte.id, barba.id]);
  out.dupla = { tenantId: tenant.id, token, services: { Corte: corte.id, Barba: barba.id }, pros: { ana: ana.id, julia: julia.id } };
}

// --- (v2) Grade: 1 serviço de 45 min, 1 profissional 09-18 todos os dias (CA-36; o cenário troca a grade 30 <-> 15 por SQL) ---
{
  const { tenant, token } = await mkTenant("grade", { name: "Grade Redonda", timezone: "America/Sao_Paulo", slotGranularityMin: 30, minLeadTimeMin: 0, maxHorizonDays: 30, reminderEnabled: false });
  const s = await svc(tenant.id, "Escova", 45, 5000, 0);
  const p = await pro(tenant.id, "Ana", 0, ALL_DAYS, "09:00", "18:00");
  await link(p.id, [s.id]);
  out.grade = { tenantId: tenant.id, token, services: { Escova: s.id }, pros: { ana: p.id } };
}

// --- (v2) Limite: cliente FIXO com 3 agendamentos futuros (CA-35). Padrão do v2 = 3 por cliente ---
{
  const { tenant, token } = await mkTenant("limite", { name: "Limite Salão", timezone: "America/Sao_Paulo", slotGranularityMin: 30, minLeadTimeMin: 0, maxHorizonDays: 30, cancelMinLeadMin: 120, reminderEnabled: false });
  const corte = await svc(tenant.id, "Corte", 60, 5000, 0);
  const escova = await svc(tenant.id, "Escova", 45, 5000, 1);
  const manicure = await svc(tenant.id, "Manicure", 60, 4000, 2);
  const ana = await pro(tenant.id, "Ana", 0, ALL_DAYS, "09:00", "18:00");
  await link(ana.id, [corte.id, escova.id, manicure.id]);
  const phone = "5511988770001";
  const contact = await prisma.contact.create({ data: { tenantId: tenant.id, waJid: `${phone}@s.whatsapp.net`, phoneE164: phone, name: "Cliente Limite", pushName: "Cliente Limite" } });
  const plan3 = [[2, 13, escova, 45], [4, 17, manicure, 60], [6, 12, corte, 60]]; // UTC 13/17/12h = 10:00/14:00/09:00 em São Paulo
  for (const [days, utcHour, s, dur] of plan3) {
    const d = new Date(Date.now() + days * 86_400_000);
    d.setUTCHours(utcHour, 0, 0, 0);
    const end = new Date(d.getTime() + dur * 60_000);
    await prisma.appointment.create({ data: { tenantId: tenant.id, contactId: contact.id, serviceId: s.id, professionalId: ana.id, startsAt: d, endsAt: end, blockEndsAt: end, status: "SCHEDULED", source: "WHATSAPP" } });
  }
  out.limite = { tenantId: tenant.id, token, services: { Corte: corte.id, Escova: escova.id, Manicure: manicure.id }, pros: { ana: ana.id }, contactPhone: phone, contactId: contact.id };
}

// --- (v2) Especial: nome de serviço com marcação do WhatsApp (CA-40) e dois "cortes" (CA-06) ---
{
  const { tenant, token } = await mkTenant("especial", { name: "Especial Salão", timezone: "America/Sao_Paulo", slotGranularityMin: 30, minLeadTimeMin: 0, maxHorizonDays: 30, reminderEnabled: false });
  const vip = await svc(tenant.id, "Corte *VIP*_2", 60, 8000, 0);
  const escova = await svc(tenant.id, "Escova", 45, 5000, 1);
  const infantil = await svc(tenant.id, "Corte infantil", 30, 3000, 2); // 2º "corte": "corte" fica ambíguo (CA-06)
  const p = await pro(tenant.id, "Lia", 0, ALL_DAYS, "09:00", "18:00");
  await link(p.id, [vip.id, escova.id, infantil.id]);
  out.especial = { tenantId: tenant.id, token, services: { Vip: vip.id, Escova: escova.id, Infantil: infantil.id }, pros: { lia: p.id } };
}

// --- (v2) Equipe: o cenário do atendente (CA-26) grava o expediente na hora (aberto agora / fechado agora) ---
{
  const { tenant, token } = await mkTenant("equipe", { name: "Equipe Salão", timezone: "America/Sao_Paulo", slotGranularityMin: 30, minLeadTimeMin: 0, maxHorizonDays: 30, reminderEnabled: false });
  const s = await svc(tenant.id, "Consulta", 30, 6000, 0);
  const p = await pro(tenant.id, "Dr. Turno", 0, ALL_DAYS, "00:00", "23:59");
  await link(p.id, [s.id]);
  out.equipe = { tenantId: tenant.id, token, services: { Consulta: s.id }, pros: { p: p.id } };
}

// --- (v2) Menus editados: MAIN_MENU legado com numeração própria (BUG-11). `menuedit` = CA-43 (o cenário grava o MENU_PROMPT);
//     `menuport` = CA-47 (o cenário roda a migration de porte sobre este MAIN_MENU) ---
const EDITED_MAIN_MENU = "Oi {nome}! Aqui é a *{empresa}*.\nEscolha uma opção:\n1. Falar com atendente\n2. Agendar horário\n3. Meus agendamentos";
for (const key of ["menuedit", "menuport"]) {
  const { tenant, token } = await mkTenant(key, { name: key === "menuedit" ? "Menu Editado" : "Menu Portado", timezone: "America/Sao_Paulo", slotGranularityMin: 30, reminderEnabled: false });
  const s = await svc(tenant.id, "Corte", 60, 5000, 0);
  const p = await pro(tenant.id, "Ana", 0, ALL_DAYS, "09:00", "18:00");
  await link(p.id, [s.id]);
  await prisma.botText.create({ data: { tenantId: tenant.id, key: "MAIN_MENU", text: EDITED_MAIN_MENU } });
  out[key] = { tenantId: tenant.id, token, services: { Corte: s.id }, pros: { ana: p.id }, legacyMainMenu: EDITED_MAIN_MENU };
}

writeFileSync(join(here, ".seed.json"), JSON.stringify({ secret: INTERNAL_SECRET, tenants: out }, null, 2));
console.log("seed ok:", Object.keys(out).join(", "));
await prisma.$disconnect();
