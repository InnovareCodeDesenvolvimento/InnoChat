import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/db/prisma";
import { setSupportCookie, clearSupportCookie } from "@/modules/support/cookie";
import { startSupportSession } from "@/modules/support/service";
import {
  createServiceAction,
  updateServiceAction,
  createProfessionalAction,
  setProfessionalServicesAction,
  setProfessionalWorkingHoursAction,
  createScheduleExceptionAction,
} from "@/modules/agenda/catalog-actions";

const session = vi.hoisted(() => ({ userId: null as string | null }));
const cookieStoreMap = vi.hoisted(() => new Map<string, { value: string; options?: unknown }>());

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => (session.userId ? { user: { id: session.userId } } : null)),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const entry = cookieStoreMap.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    set: (name: string, value: string, options?: unknown) => {
      cookieStoreMap.set(name, { value, options });
    },
    delete: (name: string) => {
      cookieStoreMap.delete(name);
    },
  })),
}));

describe("Onda 2 — Catálogo com Suporte e Auditoria", () => {
  const prisma = getPrisma();
  let adminUser: { id: string; email: string };
  let regularUser: { id: string; email: string };
  let tenant: { id: string; slug: string };
  let planId: string;

  beforeEach(async () => {
    cookieStoreMap.clear();

    const unique = randomUUID().slice(0, 8);
    // Cria admin com 2FA ativa
    adminUser = await prisma.user.create({
      data: {
        email: `admin-cat-${unique}@test.local`,
        name: "Admin Suporte Catálogo",
        passwordHash: "$2b$10$fakehashfortestingpurposesonly00",
        isPlatformAdmin: true,
        totpSecretEnc: "enc:v1:faketotpsecretforexample",
        totpEnabledAt: new Date(),
      },
      select: { id: true, email: true },
    });

    // Cria usuário comum (membro do tenant como OWNER)
    regularUser = await prisma.user.create({
      data: {
        email: `owner-cat-${unique}@test.local`,
        name: "Dono do Salão",
        passwordHash: "$2b$10$fakehashfortestingpurposesonly00",
      },
      select: { id: true, email: true },
    });

    // Cria plano e tenant com assinatura ativa para escrita passar no assertTenantCanWrite
    const plan = await prisma.plan.create({
      data: {
        code: `plan-cat-${unique}`,
        name: "Plano Catálogo Test",
        priceCents: 4990,
        maxWhatsappNumbers: 1,
        maxProfessionals: 10,
        active: false,
        sortOrder: 999,
      },
      select: { id: true },
    });
    planId = plan.id;

    tenant = await prisma.tenant.create({
      data: {
        name: `Tenant Catálogo ${unique}`,
        slug: `tenant-cat-${unique}`,
        timezone: "America/Sao_Paulo",
        memberships: {
          create: {
            userId: regularUser.id,
            role: "OWNER",
          },
        },
        subscription: {
          create: {
            planId: plan.id,
            status: "TRIALING",
            trialEndsAt: new Date(Date.now() + 7 * 86400000),
            currentPeriodEnd: new Date(Date.now() + 7 * 86400000),
          },
        },
      },
      select: { id: true, slug: true },
    });
  });

  afterEach(async () => {
    session.userId = null;
    cookieStoreMap.clear();

    if (tenant?.id) {
      await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.supportSession.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.subscription.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.scheduleException.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.workingHour.deleteMany({ where: { professional: { tenantId: tenant.id } } });
      await prisma.professionalService.deleteMany({ where: { professional: { tenantId: tenant.id } } });
      await prisma.professional.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.service.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.membership.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => null);
    }
    if (planId) {
      await prisma.plan.delete({ where: { id: planId } }).catch(() => null);
    }
    if (adminUser?.id) {
      await prisma.user.delete({ where: { id: adminUser.id } }).catch(() => null);
    }
    if (regularUser?.id) {
      await prisma.user.delete({ where: { id: regularUser.id } }).catch(() => null);
    }
  });

  it("admin com sessão de suporte válida edita serviço e profissional com actorRole PLATFORM_ADMIN e supportSessionId", async () => {
    const supportRes = await startSupportSession({
      adminUserId: adminUser.id,
      tenantId: tenant.id,
      reason: "Configuração inicial de catálogo a pedido do cliente",
      ip: null,
      userAgent: null,
    });
    await setSupportCookie(supportRes.cookieValue);
    session.userId = adminUser.id;

    // 1. Criar serviço como suporte
    const srvResult = await createServiceAction(tenant.slug, {
      name: "Corte Suporte",
      durationMin: 30,
      priceCents: 5000,
      active: true,
    });
    if (!srvResult.ok) throw new Error(srvResult.error.message);
    const service = srvResult.data as { id: string; name: string };

    const serviceAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "service.created",
        targetId: service.id,
      },
    });
    expect(serviceAudit).not.toBeNull();
    expect(serviceAudit?.actorRole).toBe("PLATFORM_ADMIN");
    expect(serviceAudit?.actorUserId).toBe(adminUser.id);
    expect(serviceAudit?.supportSessionId).toBe(supportRes.sessionId);

    // 2. Criar profissional como suporte
    const profResult = await createProfessionalAction(tenant.slug, {
      name: "Profissional Suporte",
      active: true,
      sortOrder: 1,
    });
    if (!profResult.ok) throw new Error(profResult.error.message);
    const prof = profResult.data as { id: string; name: string };

    const profAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "professional.created",
        targetId: prof.id,
      },
    });
    expect(profAudit).not.toBeNull();
    expect(profAudit?.actorRole).toBe("PLATFORM_ADMIN");
    expect(profAudit?.actorUserId).toBe(adminUser.id);
    expect(profAudit?.supportSessionId).toBe(supportRes.sessionId);

    // 3. Vincular serviço ao profissional como suporte
    const linkResult = await setProfessionalServicesAction(tenant.slug, prof.id, {
      serviceIds: [service.id],
    });
    expect(linkResult.ok).toBe(true);

    const linkAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "professional.services_changed",
        targetId: prof.id,
      },
    });
    expect(linkAudit?.actorRole).toBe("PLATFORM_ADMIN");
    expect(linkAudit?.supportSessionId).toBe(supportRes.sessionId);

    // 4. Alterar horários de funcionamento do profissional como suporte
    const hoursResult = await setProfessionalWorkingHoursAction(tenant.slug, prof.id, {
      hours: [
        { weekday: 1, startTime: "09:00", endTime: "18:00" },
        { weekday: 2, startTime: "09:00", endTime: "18:00" },
      ],
    });
    expect(hoursResult.ok).toBe(true);

    const hoursAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "working_hours.changed",
        targetId: prof.id,
      },
    });
    expect(hoursAudit?.actorRole).toBe("PLATFORM_ADMIN");
    expect(hoursAudit?.supportSessionId).toBe(supportRes.sessionId);

    // 5. Criar bloqueio de agenda (ScheduleException) como suporte
    const blockResult = await createScheduleExceptionAction(tenant.slug, {
      professionalId: prof.id,
      type: "BLOCK",
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      endsAt: new Date(Date.now() + 90000000).toISOString(),
      reason: "Manutenção de equipamentos",
    });
    if (!blockResult.ok) throw new Error(blockResult.error.message);
    const block = blockResult.data as { id: string };

    const blockAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "schedule_block.created",
        targetId: block.id,
      },
    });
    expect(blockAudit?.actorRole).toBe("PLATFORM_ADMIN");
    expect(blockAudit?.supportSessionId).toBe(supportRes.sessionId);

    // 6. Atualizar serviço (mudança de preço) como suporte
    const updateResult = await updateServiceAction(tenant.slug, service.id, {
      priceCents: 7500,
      priceChangeReason: "Reajuste anual de insumos da clínica",
    });
    expect(updateResult.ok).toBe(true);

    const updateAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "service.price_changed",
        targetId: service.id,
      },
    });
    expect(updateAudit?.actorRole).toBe("PLATFORM_ADMIN");
    expect(updateAudit?.supportSessionId).toBe(supportRes.sessionId);
  });

  it("admin sem sessão de suporte válida é bloqueado com NOT_FOUND", async () => {
    // Admin logado mas sem cookie de suporte ativo
    session.userId = adminUser.id;
    await clearSupportCookie();

    const res = await createServiceAction(tenant.slug, {
      name: "Corte Não Permitido",
      durationMin: 30,
      priceCents: 5000,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("NOT_FOUND");
    }
  });

  it("membro comum do tenant continua operando com actorRole OWNER e supportSessionId null (sem regressão)", async () => {
    session.userId = regularUser.id;
    await clearSupportCookie();

    const res = await createServiceAction(tenant.slug, {
      name: "Corte do Dono",
      durationMin: 45,
      priceCents: 6000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.message);
    const srv = res.data as { id: string };

    const audit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        action: "service.created",
        targetId: srv.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorRole).toBe("OWNER");
    expect(audit?.actorUserId).toBe(regularUser.id);
    expect(audit?.supportSessionId).toBeNull();
  });
});
