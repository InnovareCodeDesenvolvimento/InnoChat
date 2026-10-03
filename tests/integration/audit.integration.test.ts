/**
 * Registro de auditoria (Melhoria 4) contra Postgres real: gravação que nunca derruba a ação, redação de segredos,
 * append-only, isolamento por empresa nas telas, filtros e paginação, e a cobertura das ações principais chamando as
 * Server Actions de verdade (só os guards são trocados: não há sessão Auth.js fora do Next).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/auth/guards";

const session: { ctx: TenantContext | null; adminId: string } = { ctx: null, adminId: "" };
vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: async (slug: string, roles?: string[]) => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.ctx || session.ctx.tenant.slug !== slug) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    if (roles && roles.length > 0 && !roles.includes(session.ctx.membership.role)) throw new DomainError("FORBIDDEN", "Sem permissão para esta ação.");
    return session.ctx;
  },
  requirePlatformAdmin: async () => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.adminId) throw new DomainError("FORBIDDEN", "Requer acesso de administrador da plataforma.");
    return { id: session.adminId };
  },
}));

import { recordAudit } from "@/modules/audit/record";
import { listAdminAuditAction, listTenantAuditAction } from "@/modules/audit/actions";
import { cancelAppointmentAction, completeAppointmentAction, rescheduleAppointmentAction } from "@/modules/agenda/appointment-actions";
import { createServiceAction, setProfessionalCommissionAction, setProfessionalWorkingHoursAction, updateServiceAction } from "@/modules/agenda/catalog-actions";
import { updateBotRulesAction } from "@/modules/tenant/actions";
import { setCouponActiveAction } from "@/modules/billing/coupon-actions";
import { suspendCompanyAction, updatePlanAction } from "@/modules/billing/admin-actions";
import { removeMercadoPagoSecretAction, saveMercadoPagoCredentialsAction } from "@/modules/platform/actions";
import { setPlatformWhatsappEnabledAction } from "@/modules/platform/platform-whatsapp-actions";

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const tenantIds: string[] = [];
const userIds: string[] = [];
const planIds: string[] = [];
const couponIds: string[] = [];
// Admin de verdade: `PlatformSettings.updatedByUserId` tem FK para User.
const adminUser = await prisma.user.create({ data: { email: `admin-aud-${run}@example.test`, name: "Admin Auditoria", passwordHash: "x", isPlatformAdmin: true } });
userIds.push(adminUser.id);
const ADMIN = adminUser.id;

async function world(label: string, role: "OWNER" | "STAFF" = "OWNER") {
  const tenant = await prisma.tenant.create({
    data: { slug: `it-aud-${label}-${run}`, name: `Aud ${label}`, timezone: "America/Sao_Paulo", minLeadTimeMin: 0, cancelMinLeadMin: 0 },
  });
  tenantIds.push(tenant.id);
  const plan = await prisma.plan.create({ data: { code: `it-aud-${run}-${planIds.length}`, name: `Plano ${label}`, priceCents: 4990, maxWhatsappNumbers: 5, maxProfessionals: 50, active: false, sortOrder: 999 } });
  planIds.push(plan.id);
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) } });
  const user = await prisma.user.create({ data: { email: `dono-${label}-${run}@example.test`, name: `Dona ${label}`, passwordHash: "x" } });
  userIds.push(user.id);
  const membership = await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role } });
  const ctx: TenantContext = {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone },
    membership: { id: membership.id, role },
    user: { id: user.id },
  };
  const service = await prisma.service.create({ data: { tenantId: tenant.id, name: "Corte", durationMin: 30, priceCents: 5000 } });
  const professional = await prisma.professional.create({ data: { tenantId: tenant.id, name: "Ana" } });
  await prisma.professionalService.create({ data: { professionalId: professional.id, serviceId: service.id } });
  const contact = await prisma.contact.create({ data: { tenantId: tenant.id, waJid: `5511${Math.floor(Math.random() * 1e9)}@s.whatsapp.net`, name: "Júnior Rocha" } });
  await prisma.workingHour.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ professionalId: professional.id, weekday, startTime: "06:00", endTime: "22:00" })) });
  return { tenant, user, ctx, service, professional, contact };
}
type World = Awaited<ReturnType<typeof world>>;

const logsOf = (tenantId: string | null) => prisma.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });

beforeEach(() => {
  session.ctx = null;
  session.adminId = "";
});

afterAll(async () => {
  // O teste das credenciais do Mercado Pago mexe na linha única da plataforma: devolve o par de teste ao vazio.
  await prisma.platformSettings.updateMany({ where: { id: 1 }, data: { mpTestPublicKey: null, mpTestAccessTokenEnc: null, mpTestWebhookSecretEnc: null, updatedByUserId: null } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ tenantId: { in: tenantIds } }, { actorUserId: { in: [...userIds] } }] } });
  await prisma.subscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("recordAudit", () => {
  it("grava a linha com ator, papel, alvo e de/para; sem pedido HTTP o IP fica vazio", async () => {
    const w = await world("basico");
    await recordAudit({
      tenantId: w.tenant.id,
      actor: { userId: w.user.id, role: "OWNER" },
      action: "service.price_changed",
      targetType: "service",
      targetId: w.service.id,
      summary: "Mudou o preço.",
      changes: { priceCents: { de: 5000, para: 6000 } },
    });
    const [row] = await logsOf(w.tenant.id);
    expect(row).toMatchObject({ actorUserId: w.user.id, actorRole: "OWNER", action: "service.price_changed", targetType: "service", targetId: w.service.id, ipTruncated: null });
    expect(row!.changes).toEqual({ priceCents: { de: 5000, para: 6000 } });
  });

  it("IP explícito é gravado truncado (/24 e /48)", async () => {
    const w = await world("ip");
    await recordAudit({ tenantId: w.tenant.id, actor: { userId: null, role: "SYSTEM" }, action: "x.a", summary: "a", ip: "203.0.113.77" });
    await recordAudit({ tenantId: w.tenant.id, actor: { userId: null, role: "SYSTEM" }, action: "x.b", summary: "b", ip: "2001:db8:abcd:12::99" });
    const rows = await logsOf(w.tenant.id);
    expect(rows.map((r) => r.ipTruncated)).toEqual(["203.0.113.0", "2001:db8:abcd::"]);
  });

  it("NUNCA derruba a ação principal: empresa inexistente (FK) é engolida", async () => {
    await expect(
      recordAudit({ tenantId: "nao-existe-" + run, actor: { userId: null, role: "SYSTEM" }, action: "x.c", summary: "c" }),
    ).resolves.toBeUndefined();
  });

  it("redige segredo mesmo que o chamador passe o valor, e limita o tamanho", async () => {
    const w = await world("segredo");
    await recordAudit({
      tenantId: w.tenant.id,
      actor: { userId: null, role: "SYSTEM" },
      action: "x.d",
      summary: "d",
      changes: { smtpPassword: { de: "senha-velha-1", para: "senha-nova-2" }, nome: { de: "a", para: "b" } },
    });
    const [row] = await logsOf(w.tenant.id);
    expect(JSON.stringify(row!.changes)).not.toContain("senha-");
    expect(row!.changes).toMatchObject({ smtpPassword: { de: "[oculto]", para: "[oculto]" }, nome: { de: "a", para: "b" } });
  });

  it("dentro de uma transação, a linha nasce e morre junto com ela", async () => {
    const w = await world("tx");
    await prisma
      .$transaction(async (tx) => {
        await recordAudit({ tenantId: w.tenant.id, actor: { userId: null, role: "SYSTEM" }, action: "x.tx", summary: "tx" }, tx as never);
        throw new Error("desfaz");
      })
      .catch(() => undefined);
    expect(await logsOf(w.tenant.id)).toHaveLength(0);
  });
});

describe("append-only", () => {
  it("UPDATE é barrado pelo banco; DELETE segue permitido (retenção futura)", async () => {
    const w = await world("append");
    await recordAudit({ tenantId: w.tenant.id, actor: { userId: null, role: "SYSTEM" }, action: "x.e", summary: "e" });
    const [row] = await logsOf(w.tenant.id);
    await expect(prisma.auditLog.update({ where: { id: row!.id }, data: { summary: "adulterado" } })).rejects.toThrow(/append-only/i);
    await expect(prisma.auditLog.updateMany({ where: { id: row!.id }, data: { summary: "adulterado" } })).rejects.toThrow(/append-only/i);
    expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: row!.id } })).summary).toBe("e");
    await prisma.auditLog.delete({ where: { id: row!.id } });
  });
});

describe("ações do painel da empresa", () => {
  it("serviço: criar, mudar preço (de/para) e mudar só o nome; sem mudança nada é gravado", async () => {
    const w = await world("servico");
    session.ctx = w.ctx;
    const created = await createServiceAction(w.tenant.slug, { name: "Barba", durationMin: 30, priceCents: 3000 });
    expect(created.ok).toBe(true);

    const price = await updateServiceAction(w.tenant.slug, w.service.id, { priceCents: 6500 });
    expect(price.ok).toBe(true);
    const rename = await updateServiceAction(w.tenant.slug, w.service.id, { name: "Corte masculino" });
    expect(rename.ok).toBe(true);
    await updateServiceAction(w.tenant.slug, w.service.id, { name: "Corte masculino" }); // igual: nada novo

    const rows = await logsOf(w.tenant.id);
    expect(rows.map((r) => r.action)).toEqual(["service.created", "service.price_changed", "service.updated"]);
    expect(rows[1]!.changes).toEqual({ priceCents: { de: 5000, para: 6500 } });
    expect(rows[1]!.summary).toMatch(/R\$\s?50,00.*R\$\s?65,00/);
    expect(rows[1]).toMatchObject({ actorUserId: w.user.id, actorRole: "OWNER", targetType: "service", targetId: w.service.id });
    expect(rows[2]!.changes).toEqual({ name: { de: "Corte", para: "Corte masculino" } });
  });

  it("agenda: remarcar, concluir e cancelar geram uma linha cada, com o serviço e SEM o nome do cliente gravado", async () => {
    const w = await world("agenda");
    session.ctx = w.ctx;
    const start = new Date(Date.now() - 3 * 3_600_000);
    const appt = await prisma.appointment.create({
      data: { tenantId: w.tenant.id, contactId: w.contact.id, serviceId: w.service.id, professionalId: w.professional.id, startsAt: start, endsAt: new Date(start.getTime() + 30 * 60_000), blockEndsAt: new Date(start.getTime() + 30 * 60_000) },
    });
    const done = await completeAppointmentAction({ tenantSlug: w.tenant.slug, appointmentId: appt.id });
    expect(done.ok).toBe(true);
    // Repetir o mesmo "concluir" (duplo clique) não grava de novo.
    await completeAppointmentAction({ tenantSlug: w.tenant.slug, appointmentId: appt.id });

    // 16h UTC = 13h em Brasília: dentro do expediente e em ponto da grade.
    const at16 = (days: number) => {
      const d = new Date(Date.now() + days * 86_400_000);
      d.setUTCHours(16, 0, 0, 0);
      return d;
    };
    const future = await prisma.appointment.create({
      data: { tenantId: w.tenant.id, contactId: w.contact.id, serviceId: w.service.id, professionalId: w.professional.id, startsAt: at16(2), endsAt: new Date(at16(2).getTime() + 1_800_000), blockEndsAt: new Date(at16(2).getTime() + 1_800_000) },
    });
    const moved = await rescheduleAppointmentAction(w.tenant.slug, future.id, { startsAt: at16(3).toISOString() });
    expect(moved.ok).toBe(true);
    const canceled = await cancelAppointmentAction(w.tenant.slug, future.id, {});
    expect(canceled.ok).toBe(true);

    const rows = await logsOf(w.tenant.id);
    expect(rows.map((r) => r.action)).toEqual(["appointment.completed", "appointment.rescheduled", "appointment.canceled"]);
    expect(rows[0]!.summary).toContain("Corte");
    // LGPD (M-2 do Órion): nem o resumo nem o de/para guardam nome ou telefone do cliente; o alvo é o agendamento.
    for (const row of rows) {
      expect(JSON.stringify([row.summary, row.changes])).not.toMatch(/Júnior|Rocha/);
      expect(row.targetType).toBe("appointment");
    }
    // A tela resolve o nome pelo contato vivo e, se ele for anonimizado, mostra o que a lista de clientes mostra.
    const shown = await listTenantAuditAction(w.tenant.slug, { area: "agenda", pageSize: 100 });
    expect(shown.ok && shown.data.items.every((i) => i.clientName === "Júnior Rocha")).toBe(true);
    await prisma.contact.update({ where: { id: w.contact.id }, data: { name: null, pushName: null, phoneE164: null, waJid: `anon:${w.contact.id}` } });
    const anon = await listTenantAuditAction(w.tenant.slug, { area: "agenda", pageSize: 100 });
    expect(anon.ok && anon.data.items.every((i) => i.clientName === "Cliente sem nome")).toBe(true);
    expect(rows[0]!.changes).toEqual({ status: { de: "SCHEDULED", para: "COMPLETED" } });
    expect(rows[1]!.changes).toHaveProperty("startsAt");
  });

  it("horários e comissão: de/para legível; a comissão só do dono", async () => {
    const w = await world("horarios");
    session.ctx = w.ctx;
    await prisma.workingHour.deleteMany({ where: { professionalId: w.professional.id } }); // parte do "sem expediente"
    const hours = await setProfessionalWorkingHoursAction(w.tenant.slug, w.professional.id, { hours: [{ weekday: 1, startTime: "09:00", endTime: "18:00" }] });
    expect(hours.ok).toBe(true);
    await setProfessionalWorkingHoursAction(w.tenant.slug, w.professional.id, { hours: [{ weekday: 1, startTime: "09:00", endTime: "18:00" }] }); // igual
    const comm = await setProfessionalCommissionAction(w.tenant.slug, w.professional.id, { pct: 30, overrides: [{ serviceId: w.service.id, pct: 40 }] });
    expect(comm.ok).toBe(true);

    const rows = await logsOf(w.tenant.id);
    expect(rows.map((r) => r.action)).toEqual(["working_hours.changed", "professional.commission_changed"]);
    expect(rows[0]!.changes).toEqual({ horarios: { de: "sem expediente", para: "seg 09:00-18:00" } });
    expect(rows[1]!.changes).toEqual({
      comissao_padrao: { de: "padrão", para: "30%" },
      "comissao_servico:Corte": { de: "padrão", para: "40%" },
    });

    const staff = await world("horarios-staff", "STAFF");
    session.ctx = staff.ctx;
    const denied = await setProfessionalCommissionAction(staff.tenant.slug, staff.professional.id, { pct: 99, overrides: [] });
    expect(denied.ok).toBe(false);
    expect(await logsOf(staff.tenant.id)).toHaveLength(0);
  });

  it("regras do bot gravam o de/para; a ação recusada (STAFF) não grava nada", async () => {
    const w = await world("regras");
    session.ctx = w.ctx;
    const ok = await updateBotRulesAction(w.tenant.slug, { maxFutureAppointmentsPerContact: 5, slotGranularityMin: 15, handoffResumeMinutes: 120 });
    expect(ok.ok).toBe(true);
    const [row] = await logsOf(w.tenant.id);
    expect(row!.action).toBe("settings.bot_rules_changed");
    expect(row!.changes).toMatchObject({ slotGranularityMin: { de: 30, para: 15 }, maxFutureAppointmentsPerContact: { para: 5 } });

    const staff = await world("regras-staff", "STAFF");
    session.ctx = staff.ctx;
    const denied = await updateBotRulesAction(staff.tenant.slug, { maxFutureAppointmentsPerContact: 5, slotGranularityMin: 15, handoffResumeMinutes: 120 });
    expect(denied.ok).toBe(false);
    expect(await logsOf(staff.tenant.id)).toHaveLength(0);
  });
});

describe("ações da plataforma", () => {
  it("suspender empresa fica na empresa (visível ao dono como Equipe InnoChat) e plano/cupom ficam sem empresa", async () => {
    const w = await world("susp");
    session.adminId = ADMIN;
    const suspended = await suspendCompanyAction(w.tenant.id);
    expect(suspended.ok).toBe(true);
    const plan = planIds[planIds.length - 1]!;
    const upd = await updatePlanAction(plan, { priceCents: 9990 });
    expect(upd.ok).toBe(true);
    const coupon = await prisma.coupon.create({ data: { code: `AUD${run}`.toUpperCase(), kind: "PERCENT", value: 10 } });
    couponIds.push(coupon.id);
    const toggled = await setCouponActiveAction(coupon.id, { active: false });
    expect(toggled.ok).toBe(true);

    const [s] = await logsOf(w.tenant.id);
    expect(s).toMatchObject({ action: "company.suspended", actorRole: "PLATFORM_ADMIN", actorUserId: ADMIN });
    const platformRows = await prisma.auditLog.findMany({ where: { tenantId: null, actorUserId: ADMIN, targetId: { in: [plan, coupon.id] } } });
    expect(platformRows.map((r) => r.action).sort()).toEqual(["coupon.deactivated", "plan.price_changed"]);
    expect(platformRows.find((r) => r.action === "plan.price_changed")!.changes).toEqual({ priceCents: { de: 4990, para: 9990 } });
  });

  it("credenciais do Mercado Pago: grava QUE mudou e nunca o valor", async () => {
    session.adminId = ADMIN;
    const TOKEN = "APP_USR-token-super-secreto-1234";
    const WH = "segredo-webhook-9876";
    const saved = await saveMercadoPagoCredentialsAction({ env: "SANDBOX", publicKey: "TEST-public-key", accessToken: TOKEN, webhookSecret: WH });
    expect(saved.ok).toBe(true);
    const removed = await removeMercadoPagoSecretAction({ env: "SANDBOX", field: "accessToken" });
    expect(removed.ok).toBe(true);
    const rows = await prisma.auditLog.findMany({ where: { tenantId: null, actorUserId: ADMIN, action: { startsWith: "platform.mercadopago" } } });
    expect(rows.map((r) => r.action).sort()).toEqual(["platform.mercadopago_credentials_changed", "platform.mercadopago_secret_removed"]);
    const everything = JSON.stringify(rows);
    for (const secret of [TOKEN, WH]) expect(everything).not.toContain(secret);
    const credentials = rows.find((r) => r.action === "platform.mercadopago_credentials_changed")!;
    expect(credentials.changes).toMatchObject({ accessToken: { de: "[oculto]", para: "[oculto]" }, webhookSecret: { de: "[oculto]", para: "[oculto]" } });
  });

  it("WhatsApp da plataforma: ligar/desligar é registrado", async () => {
    session.adminId = ADMIN;
    const original = (await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { platformWhatsappEnabled: true } }))?.platformWhatsappEnabled ?? false;
    const same = await setPlatformWhatsappEnabledAction({ enabled: original });
    expect(same.ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { tenantId: null, actorUserId: ADMIN, action: "platform_whatsapp.enabled_changed" } })).toBe(0); // nada mudou
    const flipped = await setPlatformWhatsappEnabledAction({ enabled: !original });
    expect(flipped.ok).toBe(true);
    const rows = await prisma.auditLog.findMany({ where: { tenantId: null, actorUserId: ADMIN, action: "platform_whatsapp.enabled_changed" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changes).toEqual({ enabled: { de: original, para: !original } });
    await setPlatformWhatsappEnabledAction({ enabled: original });
  });
});

describe("telas: isolamento, filtros e paginação", () => {
  async function seed(w: World, n: number, action = "service.updated") {
    const base = Date.now();
    for (let i = 0; i < n; i += 1) {
      await prisma.auditLog.create({
        data: { tenantId: w.tenant.id, actorUserId: w.user.id, actorRole: "OWNER", action, summary: `Alteração ${i}`, createdAt: new Date(base - i * 1000) },
      });
    }
  }

  it("a empresa só vê o que é dela, nunca o de outra nem o da plataforma; STAFF não vê nada", async () => {
    const a = await world("iso-a");
    const b = await world("iso-b");
    await seed(a, 3);
    await seed(b, 2, "team.invited");
    await prisma.auditLog.create({ data: { tenantId: null, actorUserId: ADMIN, actorRole: "PLATFORM_ADMIN", action: "platform.settings_changed", summary: "Config da plataforma" } });
    await prisma.auditLog.create({ data: { tenantId: a.tenant.id, actorUserId: ADMIN, actorRole: "PLATFORM_ADMIN", action: "company.suspended", summary: "Suspendeu a empresa" } });

    session.ctx = a.ctx;
    const res = await listTenantAuditAction(a.tenant.slug, { pageSize: 100 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.totalItems).toBe(4);
    expect(res.data.items.every((i) => i.tenant?.id === a.tenant.id)).toBe(true);
    expect(res.data.items.some((i) => i.action === "platform.settings_changed")).toBe(false);
    // Para a empresa, a plataforma aparece como "Equipe InnoChat" (sem o nome do admin) e o IP não vai junto.
    const platformRow = res.data.items.find((i) => i.action === "company.suspended")!;
    expect(platformRow.actorName).toBe("Equipe InnoChat");
    expect(res.data.items.every((i) => i.ipTruncated === null)).toBe(true);

    // Tentar espiar outra empresa trocando o slug não funciona: o guard resolve o tenant pelo vínculo.
    const spy = await listTenantAuditAction(b.tenant.slug, {});
    expect(spy.ok).toBe(false);

    const staff = await world("iso-staff", "STAFF");
    session.ctx = staff.ctx;
    const denied = await listTenantAuditAction(staff.tenant.slug, {});
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
  });

  it("filtros da empresa: área, pessoa e período; ordem do mais novo ao mais velho", async () => {
    const w = await world("filtros");
    await seed(w, 3, "service.updated");
    await prisma.auditLog.create({ data: { tenantId: w.tenant.id, actorUserId: w.user.id, actorRole: "OWNER", action: "appointment.canceled", summary: "Cancelou", createdAt: new Date("2026-01-15T15:00:00.000Z") } });
    session.ctx = w.ctx;

    const byArea = await listTenantAuditAction(w.tenant.slug, { area: "agenda" });
    expect(byArea.ok && byArea.data.items.map((i) => i.action)).toEqual(["appointment.canceled"]);

    const byActor = await listTenantAuditAction(w.tenant.slug, { actor: `dono-filtros-${run}` });
    expect(byActor.ok && byActor.data.totalItems).toBe(4);
    const nobody = await listTenantAuditAction(w.tenant.slug, { actor: "ninguem-assim@x.test" });
    expect(nobody.ok && nobody.data.totalItems).toBe(0);

    const period = await listTenantAuditAction(w.tenant.slug, { from: "2026-01-15", to: "2026-01-15" });
    expect(period.ok && period.data.items.map((i) => i.action)).toEqual(["appointment.canceled"]);
    const empty = await listTenantAuditAction(w.tenant.slug, { from: "2026-01-16", to: "2026-01-17" });
    expect(empty.ok && empty.data.totalItems).toBe(0);

    const all = await listTenantAuditAction(w.tenant.slug, {});
    expect(all.ok && all.data.items[all.data.items.length - 1]!.action).toBe("appointment.canceled"); // o mais antigo por último

    // Área só da plataforma: nas linhas da empresa não acha nada.
    const bogus = await listTenantAuditAction(w.tenant.slug, { area: "plataforma" });
    expect(bogus.ok && bogus.data.totalItems).toBe(0);
  });

  it("paginação 10/25/50/100 com total e página fora do intervalo ajustada", async () => {
    const w = await world("pag");
    await seed(w, 27);
    session.ctx = w.ctx;
    const p1 = await listTenantAuditAction(w.tenant.slug, { page: 1, pageSize: 10 });
    expect(p1.ok && [p1.data.items.length, p1.data.totalItems, p1.data.totalPages]).toEqual([10, 27, 3]);
    const p3 = await listTenantAuditAction(w.tenant.slug, { page: 3, pageSize: 10 });
    expect(p3.ok && p3.data.items.length).toBe(7);
    const far = await listTenantAuditAction(w.tenant.slug, { page: 999, pageSize: 10 });
    expect(far.ok && far.data.page).toBe(3);
    const bad = await listTenantAuditAction(w.tenant.slug, { pageSize: 17 });
    expect(bad.ok).toBe(false);
    const big = await listTenantAuditAction(w.tenant.slug, { pageSize: 25 });
    expect(big.ok && big.data.items.length).toBe(25);
  });

  it("Admin vê todas as empresas e a plataforma, filtra por empresa e mostra o IP; só admin entra", async () => {
    const a = await world("adm-a");
    const b = await world("adm-b");
    await seed(a, 2);
    await seed(b, 1);
    await prisma.auditLog.create({ data: { tenantId: null, actorUserId: ADMIN, actorRole: "PLATFORM_ADMIN", action: "backup.run_manual", summary: "Backup", ipTruncated: "203.0.113.0" } });

    const denied = await listAdminAuditAction({});
    expect(denied.ok).toBe(false);

    session.adminId = ADMIN;
    const onlyA = await listAdminAuditAction({ tenantQuery: `Aud adm-a`, pageSize: 100 });
    expect(onlyA.ok && onlyA.data.items.every((i) => i.tenant?.id === a.tenant.id)).toBe(true);
    expect(onlyA.ok && onlyA.data.totalItems).toBe(2);

    const backup = await listAdminAuditAction({ area: "backup", pageSize: 100 });
    expect(backup.ok && backup.data.items.some((i) => i.ipTruncated === "203.0.113.0" && i.tenant === null)).toBe(true);

    const noMatch = await listAdminAuditAction({ tenantQuery: "empresa-que-nao-existe-" + run });
    expect(noMatch.ok && noMatch.data.totalItems).toBe(0);

    const detail = await listAdminAuditAction({ area: "catalogo", tenantQuery: "Aud adm-b" });
    expect(detail.ok && detail.data.items[0]!.actionLabel).toBe("Serviço alterado");
  });
});


describe("revisão final do Órion: M-1, M-2, B-3", () => {
  it("M-1: o dono vê o que a plataforma fez na empresa dele, mas NÃO o texto livre do admin; o Admin vê tudo", async () => {
    const w = await world("m1");
    const MOTIVO = `desconto combinado com o Joao ${run}`;
    await prisma.auditLog.create({
      data: { tenantId: w.tenant.id, actorUserId: ADMIN, actorRole: "PLATFORM_ADMIN", action: "invoice.marked_paid_manually", targetType: "invoice", summary: "Deu baixa manual numa fatura de R$ 49,90.", changes: { motivo: { de: null, para: MOTIVO } } },
    });
    await prisma.auditLog.create({
      data: { tenantId: w.tenant.id, actorUserId: w.user.id, actorRole: "OWNER", action: "service.updated", summary: "Alterou o serviço Corte.", changes: { name: { de: "Corte", para: "Corte masculino" } } },
    });

    session.ctx = w.ctx;
    const owner = await listTenantAuditAction(w.tenant.slug, { pageSize: 100 });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const platformRow = owner.data.items.find((i) => i.action === "invoice.marked_paid_manually")!;
    expect(platformRow.summary).toContain("baixa manual"); // o fato continua visível
    expect(platformRow.actorName).toBe("Equipe InnoChat");
    expect(platformRow.changes).toEqual([]);
    expect(JSON.stringify(owner.data)).not.toContain(MOTIVO);
    // O que o próprio dono mudou continua com o de/para.
    expect(owner.data.items.find((i) => i.action === "service.updated")!.changes).toHaveLength(1);

    session.ctx = null;
    session.adminId = ADMIN;
    const admin = await listAdminAuditAction({ tenantQuery: `Aud m1`, pageSize: 100 });
    expect(admin.ok && admin.data.items.find((i) => i.action === "invoice.marked_paid_manually")!.changes[0]!.to).toBe(MOTIVO);
  });

  it("M-2: lista de espera e convite de equipe não gravam nome nem e-mail inteiro; o nome vem do contato vivo", async () => {
    const w = await world("m2");
    session.ctx = w.ctx;
    const { addWaitlistEntryAction } = await import("@/modules/waitlist/actions");
    const { inviteTeamMemberAction } = await import("@/modules/signup/actions");
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const added = await addWaitlistEntryAction(w.tenant.slug, { contactId: w.contact.id, serviceId: w.service.id, date: day });
    expect(added.ok).toBe(true);
    const invited = await inviteTeamMemberAction(w.tenant.slug, { email: `anabela.${run}@exemplo.com.br`, role: "STAFF" });
    expect(invited.ok).toBe(true);

    const rows = await logsOf(w.tenant.id);
    const wl = rows.find((r) => r.action === "waitlist.added")!;
    expect(wl.summary).not.toMatch(/Júnior|Rocha/);
    expect(wl.targetType).toBe("waitlist_entry");
    const inv = rows.find((r) => r.action === "team.invited")!;
    expect(inv.summary).toContain("an***@exemplo.com.br");
    expect(inv.summary).not.toContain("anabela");

    const shown = await listTenantAuditAction(w.tenant.slug, { area: "agenda" });
    expect(shown.ok && shown.data.items[0]!.clientName).toBe("Júnior Rocha");
    // Nada do contato ficou em nenhuma linha gravada da empresa.
    expect(JSON.stringify(rows)).not.toMatch(/Júnior|Rocha/);
  });

  it("B-3: o filtro por pessoa, na empresa, só enxerga membros dela e nunca a equipe da plataforma", async () => {
    const a = await world("b3a");
    const b = await world("b3b");
    await prisma.auditLog.create({ data: { tenantId: a.tenant.id, actorUserId: ADMIN, actorRole: "PLATFORM_ADMIN", action: "company.suspended", summary: "Suspendeu a empresa" } });
    await prisma.auditLog.create({ data: { tenantId: a.tenant.id, actorUserId: a.user.id, actorRole: "OWNER", action: "service.updated", summary: "Mudou" } });
    await prisma.auditLog.create({ data: { tenantId: b.tenant.id, actorUserId: b.user.id, actorRole: "OWNER", action: "service.updated", summary: "Mudou na outra" } });

    session.ctx = a.ctx;
    // Digitar o e-mail do admin da plataforma não revela as linhas "Equipe InnoChat".
    const spyAdmin = await listTenantAuditAction(a.tenant.slug, { actor: `admin-aud-${run}` });
    expect(spyAdmin.ok && spyAdmin.data.totalItems).toBe(0);
    // Membro de OUTRA empresa também não é achado aqui.
    const other = await listTenantAuditAction(a.tenant.slug, { actor: `dono-b3b-${run}` });
    expect(other.ok && other.data.totalItems).toBe(0);
    // Membro da própria empresa funciona.
    const own = await listTenantAuditAction(a.tenant.slug, { actor: `dono-b3a-${run}` });
    expect(own.ok && own.data.items.map((i) => i.action)).toEqual(["service.updated"]);

    // O Admin continua achando a equipe da plataforma pelo filtro.
    session.ctx = null;
    session.adminId = ADMIN;
    const adminSide = await listAdminAuditAction({ actor: `admin-aud-${run}`, tenantQuery: "Aud b3a" });
    expect(adminSide.ok && adminSide.data.totalItems).toBe(1);
  });
});
