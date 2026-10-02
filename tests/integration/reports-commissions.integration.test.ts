/**
 * Relatórios com comissões (Melhoria 8) contra Postgres real: foto de valores ao concluir, herança da comissão,
 * atendimentos antigos (sem foto) como estimados, isolamento entre empresas, acesso só do dono e corte por fuso.
 * As actions e a rota do CSV são chamadas de verdade; só `requireTenantMember` é trocado (sem sessão Auth.js
 * fora do Next), mas respeitando a lista de papéis, que é o que o guard real faz.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/auth/guards";

const session: { ctx: TenantContext | null } = { ctx: null };
vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: async (slug: string, roles?: string[]) => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.ctx || session.ctx.tenant.slug !== slug) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    if (roles && roles.length > 0 && !roles.includes(session.ctx.membership.role)) {
      throw new DomainError("FORBIDDEN", "Sem permissão para esta ação.");
    }
    return session.ctx;
  },
}));

import { completeAppointmentAction, markNoShowAppointmentAction, reopenAppointmentAction } from "@/modules/agenda/appointment-actions";
import {
  getCommissionConfigAction,
  setProfessionalCommissionAction,
  setProfessionalServicesAction,
} from "@/modules/agenda/catalog-actions";
import { getReport } from "@/modules/reports/service";
import { GET as csvRoute } from "@/app/api/reports/csv/route";

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
const planIds: string[] = [];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function makeWorld(label: string, role: "OWNER" | "STAFF" = "OWNER") {
  const tenant = await prisma.tenant.create({
    data: { slug: `it-rel-${label}-${randomUUID().slice(0, 8)}`, name: `Rel ${label}`, timezone: "America/Sao_Paulo", minLeadTimeMin: 0, cancelMinLeadMin: 0 },
  });
  tenantIds.push(tenant.id);
  const plan = await prisma.plan.create({
    data: { code: `it-rel-${randomUUID().slice(0, 8)}`, name: "Plano IT", priceCents: 4990, maxWhatsappNumbers: 5, maxProfessionals: 50, active: false, sortOrder: 999 },
  });
  planIds.push(plan.id);
  const periodEnd = new Date(Date.now() + 10 * DAY);
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt: periodEnd, currentPeriodEnd: periodEnd } });
  const user = await prisma.user.create({ data: { email: `rel-${randomUUID().slice(0, 6)}@example.test`, passwordHash: "x" } });
  userIds.push(user.id);
  const membership = await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role } });
  const corte = await prisma.service.create({ data: { tenantId: tenant.id, name: "Corte", durationMin: 30, priceCents: 5000 } });
  const quimica = await prisma.service.create({ data: { tenantId: tenant.id, name: "Química", durationMin: 30, priceCents: 10000 } });
  const retoque = await prisma.service.create({ data: { tenantId: tenant.id, name: "Retoque", durationMin: 30, priceCents: 3333 } });
  const ana = await prisma.professional.create({ data: { tenantId: tenant.id, name: "Ana", commissionPct: 40 } });
  await prisma.professionalService.createMany({
    data: [
      { professionalId: ana.id, serviceId: corte.id },
      { professionalId: ana.id, serviceId: quimica.id, commissionPct: 30 },
      { professionalId: ana.id, serviceId: retoque.id, commissionPct: 0 },
    ],
  });
  const contact = await prisma.contact.create({ data: { tenantId: tenant.id, waJid: `5511${Math.floor(Math.random() * 1e9)}@s.whatsapp.net`, name: "Cliente" } });
  const ctx: TenantContext = {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone },
    membership: { id: membership.id, role },
    user: { id: user.id },
  };
  return { tenant, ctx, corte, quimica, retoque, ana, contact };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

let slot = 0;
async function makeAppointment(w: World, serviceId: string, startsAt: Date, status: "SCHEDULED" | "COMPLETED" | "NO_SHOW" | "CANCELED" = "SCHEDULED", professionalId = w.ana.id) {
  slot += 1;
  return prisma.appointment.create({
    data: {
      tenantId: w.tenant.id,
      contactId: w.contact.id,
      serviceId,
      professionalId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * MIN),
      blockEndsAt: new Date(startsAt.getTime() + 30 * MIN),
      status,
      idempotencyKey: `rel-${slot}-${randomUUID().slice(0, 6)}`,
    },
  });
}

const snapshotOf = (id: string) =>
  prisma.appointment.findUniqueOrThrow({
    where: { id },
    select: { status: true, priceCentsSnapshot: true, commissionPctSnapshot: true, commissionCentsSnapshot: true },
  });

const input = (w: World, appointmentId: string) => ({ tenantSlug: w.tenant.slug, appointmentId });
const past = (ms: number) => new Date(Date.now() - ms);

beforeEach(() => {
  session.ctx = null;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

describe("foto de valores ao concluir", () => {
  it("grava preço, % e comissão ao virar COMPLETED, e o histórico não muda quando preço e comissão mudam depois", async () => {
    const w = await makeWorld("snap");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, w.corte.id, past(2 * HOUR));
    expect((await completeAppointmentAction(input(w, appt.id))).ok).toBe(true);

    const snap = await snapshotOf(appt.id);
    expect(snap.priceCentsSnapshot).toBe(5000);
    expect(Number(snap.commissionPctSnapshot)).toBe(40);
    expect(snap.commissionCentsSnapshot).toBe(2000);

    // Dono mexe no preço e na comissão depois.
    await prisma.service.update({ where: { id: w.corte.id }, data: { priceCents: 9000 } });
    await prisma.professional.update({ where: { id: w.ana.id }, data: { commissionPct: 10 } });

    const report = await getReport(w.tenant.id, "America/Sao_Paulo", { preset: "last_30_days" });
    expect(report.summary.revenueCents).toBe(5000);
    expect(report.summary.commissionCents).toBe(2000);
    expect(report.summary.estimatedCount).toBe(0);
  });

  it("repetir o concluir (duplo clique) não regrava nem duplica", async () => {
    const w = await makeWorld("dup");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, w.corte.id, past(2 * HOUR));
    await completeAppointmentAction(input(w, appt.id));
    await prisma.service.update({ where: { id: w.corte.id }, data: { priceCents: 7000 } });
    await completeAppointmentAction(input(w, appt.id));
    expect((await snapshotOf(appt.id)).priceCentsSnapshot).toBe(5000);
  });

  it("falta não grava foto; reabrir zera e concluir de novo usa o preço da hora", async () => {
    const w = await makeWorld("reopen");
    session.ctx = w.ctx;
    const noShow = await makeAppointment(w, w.corte.id, past(3 * HOUR));
    await markNoShowAppointmentAction(input(w, noShow.id));
    expect((await snapshotOf(noShow.id)).priceCentsSnapshot).toBeNull();

    const appt = await makeAppointment(w, w.corte.id, past(2 * HOUR));
    await completeAppointmentAction(input(w, appt.id));
    await reopenAppointmentAction(input(w, appt.id));
    expect(await snapshotOf(appt.id)).toMatchObject({ status: "SCHEDULED", priceCentsSnapshot: null, commissionPctSnapshot: null, commissionCentsSnapshot: null });

    await prisma.service.update({ where: { id: w.corte.id }, data: { priceCents: 6000 } });
    await completeAppointmentAction(input(w, appt.id));
    expect((await snapshotOf(appt.id)).priceCentsSnapshot).toBe(6000);
    expect((await snapshotOf(appt.id)).commissionCentsSnapshot).toBe(2400);
  });

  it("a tela do atendimento não devolve a comissão (omit global): o campo some das leituras comuns", async () => {
    const w = await makeWorld("omit");
    const appt = await makeAppointment(w, w.corte.id, past(2 * HOUR), "COMPLETED");
    const row = (await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id }, include: { professional: true } })) as Record<string, unknown>;
    expect(row).not.toHaveProperty("commissionCentsSnapshot");
    expect(row.professional as object).not.toHaveProperty("commissionPct");
  });
});

describe("herança e arredondamento no relatório", () => {
  it("usa o % do serviço quando existe (inclusive 0) e o do profissional nos demais; arredonda ao centavo", async () => {
    const w = await makeWorld("heranca");
    // Concluídos antigos (sem foto) para a conta sair do banco com os valores atuais.
    await makeAppointment(w, w.corte.id, past(10 * HOUR), "COMPLETED"); // 5000 x 40% = 2000
    await makeAppointment(w, w.quimica.id, past(9 * HOUR), "COMPLETED"); // 10000 x 30% = 3000
    await makeAppointment(w, w.retoque.id, past(8 * HOUR), "COMPLETED"); // 3333 x 0% = 0 (zero NÃO herda os 40%)
    await prisma.professionalService.updateMany({ where: { professionalId: w.ana.id, serviceId: w.corte.id }, data: { commissionPct: 33.33 } });
    // 5000 x 33,33% = 1666,5 -> sobe para 1667
    const report = await getReport(w.tenant.id, "America/Sao_Paulo", { preset: "last_30_days" });
    const byService = Object.fromEntries(report.byService.map((l) => [l.name, l]));
    expect(byService["Corte"].commissionCents).toBe(1667);
    expect(byService["Química"].commissionCents).toBe(3000);
    expect(byService["Retoque"].commissionCents).toBe(0);
    expect(report.summary.revenueCents).toBe(5000 + 10000 + 3333);
    expect(report.summary.estimatedCount).toBe(3);
    expect(report.byProfessional).toHaveLength(1);
    expect(report.byProfessional[0].commissionCents).toBe(1667 + 3000);
  });

  it("sem comissão cadastrada no profissional e no serviço: 0", async () => {
    const w = await makeWorld("zero");
    const bia = await prisma.professional.create({ data: { tenantId: w.tenant.id, name: "Bia" } });
    await makeAppointment(w, w.corte.id, past(5 * HOUR), "COMPLETED", bia.id);
    const report = await getReport(w.tenant.id, "America/Sao_Paulo", { preset: "last_30_days" });
    expect(report.summary.revenueCents).toBe(5000);
    expect(report.summary.commissionCents).toBe(0);
  });

  it("taxa de faltas por profissional e ticket médio; agendados e cancelados não entram", async () => {
    const w = await makeWorld("faltas");
    await makeAppointment(w, w.corte.id, past(10 * HOUR), "COMPLETED");
    await makeAppointment(w, w.quimica.id, past(9 * HOUR), "COMPLETED");
    await makeAppointment(w, w.corte.id, past(8 * HOUR), "NO_SHOW");
    await makeAppointment(w, w.corte.id, past(7 * HOUR), "CANCELED");
    await makeAppointment(w, w.corte.id, new Date(Date.now() + 2 * HOUR), "SCHEDULED");
    const report = await getReport(w.tenant.id, "America/Sao_Paulo", { preset: "last_30_days" });
    expect(report.summary.completed).toBe(2);
    expect(report.summary.noShow).toBe(1);
    expect(report.summary.ticketCents).toBe(7500);
    expect(report.byProfessional[0].noShowRatePercent).toBeCloseTo(33.3, 1);
  });
});

describe("fuso da empresa", () => {
  it("atendimento às 23h30 do último dia do mês (horário de Brasília) conta nesse mês, não no seguinte", async () => {
    const w = await makeWorld("fuso");
    // 2026-09-30 23:30 em Brasília (UTC-3) = 2026-10-01 02:30 UTC.
    await makeAppointment(w, w.corte.id, new Date("2026-10-01T02:30:00.000Z"), "COMPLETED");
    // 2026-10-01 00:10 em Brasília = 03:10 UTC: já é outubro.
    await makeAppointment(w, w.quimica.id, new Date("2026-10-01T03:10:00.000Z"), "COMPLETED");

    const sept = await getReport(w.tenant.id, "America/Sao_Paulo", { preset: "custom", from: "2026-09-01", to: "2026-09-30" });
    const oct = await getReport(w.tenant.id, "America/Sao_Paulo", { preset: "custom", from: "2026-10-01", to: "2026-10-31" });
    expect(sept.summary.revenueCents).toBe(5000);
    expect(oct.summary.revenueCents).toBe(10000);
  });
});

describe("isolamento entre empresas", () => {
  it("o relatório de uma empresa nunca soma atendimentos da outra", async () => {
    const a = await makeWorld("iso-a");
    const b = await makeWorld("iso-b");
    await makeAppointment(a, a.corte.id, past(3 * HOUR), "COMPLETED");
    await makeAppointment(b, b.quimica.id, past(3 * HOUR), "COMPLETED");
    await makeAppointment(b, b.quimica.id, past(2 * HOUR), "COMPLETED");
    const ra = await getReport(a.tenant.id, "America/Sao_Paulo", { preset: "last_30_days" });
    const rb = await getReport(b.tenant.id, "America/Sao_Paulo", { preset: "last_30_days" });
    expect(ra.summary.revenueCents).toBe(5000);
    expect(rb.summary.revenueCents).toBe(20000);
  });

  it("não dá para gravar comissão em profissional de outra empresa nem em serviço que ele não atende", async () => {
    const a = await makeWorld("iso-c");
    const b = await makeWorld("iso-d");
    session.ctx = a.ctx;
    const other = await setProfessionalCommissionAction(a.tenant.slug, b.ana.id, { pct: 99, overrides: [] });
    expect(other.ok).toBe(false);
    expect((await prisma.professional.findUniqueOrThrow({ where: { id: b.ana.id }, select: { commissionPct: true } })).commissionPct?.toString()).toBe("40");

    const solo = await prisma.professional.create({ data: { tenantId: a.tenant.id, name: "Solo" } });
    const unlinked = await setProfessionalCommissionAction(a.tenant.slug, solo.id, { pct: 10, overrides: [{ serviceId: a.corte.id, pct: 5 }] });
    expect(unlinked.ok).toBe(false);
    // Serviço de OUTRA empresa também não passa (não está vinculado a este profissional).
    const foreign = await setProfessionalCommissionAction(a.tenant.slug, a.ana.id, { pct: 10, overrides: [{ serviceId: b.corte.id, pct: 5 }] });
    expect(foreign.ok).toBe(false);
  });
});

describe("acesso só do dono", () => {
  it("STAFF não lê nem grava comissão (FORBIDDEN) e a rota do CSV responde 403", async () => {
    const w = await makeWorld("staff", "STAFF");
    session.ctx = w.ctx;
    const read = await getCommissionConfigAction(w.tenant.slug);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("FORBIDDEN");
    const write = await setProfessionalCommissionAction(w.tenant.slug, w.ana.id, { pct: 1, overrides: [] });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe("FORBIDDEN");

    const res = await csvRoute(new Request(`http://localhost/api/reports/csv?tenant=${w.tenant.slug}`));
    expect(res.status).toBe(403);
  });

  it("dono baixa o CSV com cabeçalho, BOM e células protegidas contra fórmula", async () => {
    const w = await makeWorld("csv");
    session.ctx = w.ctx;
    await prisma.service.update({ where: { id: w.corte.id }, data: { name: "=HYPERLINK(\"http://x\")" } });
    await makeAppointment(w, w.corte.id, past(2 * HOUR), "COMPLETED");
    const res = await csvRoute(new Request(`http://localhost/api/reports/csv?tenant=${w.tenant.slug}&periodo=last_30_days`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    // `Response.text()` descarta o BOM; confere os bytes (EF BB BF) à parte.
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await res.text();
    expect(text.startsWith("Profissional;Serviço;")).toBe(true);
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain("50,00");
    expect(text).toContain("20,00");
  });

  it("parâmetro inválido vira 400 estruturado", async () => {
    const w = await makeWorld("badq");
    session.ctx = w.ctx;
    const res = await csvRoute(new Request(`http://localhost/api/reports/csv?tenant=${w.tenant.slug}&periodo=ontem`));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_PAYLOAD");
  });
});

describe("cadastro de comissão", () => {
  it("dono grava e lê; valor fora de 0 a 100 é recusado", async () => {
    const w = await makeWorld("cad");
    session.ctx = w.ctx;
    const ok = await setProfessionalCommissionAction(w.tenant.slug, w.ana.id, {
      pct: 45.5,
      overrides: [{ serviceId: w.quimica.id, pct: 25 }, { serviceId: w.retoque.id, pct: null }],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.pct).toBe(45.5);
      expect(ok.data.overrides.find((o) => o.serviceId === w.quimica.id)?.pct).toBe(25);
      expect(ok.data.overrides.find((o) => o.serviceId === w.retoque.id)?.pct).toBeNull();
    }
    expect((await setProfessionalCommissionAction(w.tenant.slug, w.ana.id, { pct: 100.01, overrides: [] })).ok).toBe(false);
    expect((await setProfessionalCommissionAction(w.tenant.slug, w.ana.id, { pct: -1, overrides: [] })).ok).toBe(false);
  });

  it("Salvar serviços não apaga a comissão por serviço de quem continua na lista", async () => {
    const w = await makeWorld("keep");
    session.ctx = w.ctx;
    const r = await setProfessionalServicesAction(w.tenant.slug, w.ana.id, { serviceIds: [w.corte.id, w.quimica.id] });
    expect(r.ok).toBe(true);
    const links = await prisma.professionalService.findMany({ where: { professionalId: w.ana.id }, select: { serviceId: true, commissionPct: true } });
    expect(links).toHaveLength(2);
    expect(Number(links.find((l) => l.serviceId === w.quimica.id)?.commissionPct)).toBe(30);
  });
});
