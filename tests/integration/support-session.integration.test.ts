import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/db/prisma";
import { requireTenantMember } from "@/lib/auth/guards";
import { setSupportCookie, clearSupportCookie, SUPPORT_COOKIE_NAME } from "@/modules/support/cookie";
import { startSupportSession, validateSupportSession, closeSupportSession } from "@/modules/support/service";
import { DomainError } from "@/lib/errors";

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

describe("Support Module & requireTenantMember Integration", () => {
  const prisma = getPrisma();
  let adminUser: { id: string; email: string };
  let tenant: { id: string; slug: string };

  beforeEach(async () => {
    cookieStoreMap.clear();

    const unique = randomUUID().slice(0, 8);
    // Cria admin com 2FA
    adminUser = await prisma.user.create({
      data: {
        email: `admin-supp-${unique}@test.local`,
        name: "Admin Suporte",
        passwordHash: "$2b$10$fakehashfortestingpurposesonly00",
        isPlatformAdmin: true,
        totpSecretEnc: "enc:v1:faketotpsecretforexample",
        totpEnabledAt: new Date(),
      },
      select: { id: true, email: true },
    });

    // Cria tenant sem membership para este admin
    tenant = await prisma.tenant.create({
      data: {
        name: `Tenant Suporte ${unique}`,
        slug: `tenant-supp-${unique}`,
        timezone: "America/Sao_Paulo",
      },
      select: { id: true, slug: true },
    });

    session.userId = adminUser.id;
  });

  afterEach(async () => {
    session.userId = null;
    cookieStoreMap.clear();

    if (tenant?.id) {
      await prisma.supportSession.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => null);
    }
    if (adminUser?.id) {
      await prisma.user.delete({ where: { id: adminUser.id } }).catch(() => null);
    }
  });

  it("admin sem membership e sem cookie de suporte recebe NOT_FOUND ao chamar requireTenantMember", async () => {
    await expect(requireTenantMember(tenant.slug)).rejects.toThrowError(DomainError);
    await expect(requireTenantMember(tenant.slug)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("admin com cookie de suporte válido entra no tenant sem Membership com papel OWNER virtual e isSupportImpersonation", async () => {
    const startRes = await startSupportSession({
      adminUserId: adminUser.id,
      tenantId: tenant.id,
      reason: "Auditoria técnica autorizada para resolução de chamados",
      ip: null,
      userAgent: null,
    });

    await setSupportCookie(startRes.cookieValue);

    const ctx = await requireTenantMember(tenant.slug);
    expect(ctx.isSupportImpersonation).toBe(true);
    expect(ctx.supportSessionId).toBe(startRes.sessionId);
    expect(ctx.membership.id).toBe("support-session");
    expect(ctx.membership.role).toBe("OWNER");
    expect(ctx.tenant.id).toBe(tenant.id);
    expect(ctx.tenant.slug).toBe(tenant.slug);
  });

  it("sessão expirada redireciona para tela de empresa com expirou=1", async () => {
    // Cria sessão já expirada no banco
    const now = new Date();
    const expiredSess = await prisma.supportSession.create({
      data: {
        adminUserId: adminUser.id,
        tenantId: tenant.id,
        reason: "Teste de sessão expirada no banco de dados",
        startedAt: new Date(now.getTime() - 7200_000),
        expiresAt: new Date(now.getTime() - 3600_000),
      },
    });

    // Gera cookie assinado com exp passada
    const { signSupportCookiePayload } = await import("@/modules/support/service");
    const cookieVal = signSupportCookiePayload({
      sessionId: expiredSess.id,
      adminUserId: adminUser.id,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      exp: now.getTime() - 3600_000,
    });

    await setSupportCookie(cookieVal);

    // Deve redirecionar (Next lança erro NEXT_REDIRECT)
    await expect(requireTenantMember(tenant.slug)).rejects.toThrowError();

    // Sessão no banco deve ter sido marcada como EXPIRED
    const dbSess = await prisma.supportSession.findUnique({ where: { id: expiredSess.id } });
    expect(dbSess?.closedAt).not.toBeNull();
    expect(dbSess?.closeReason).toBe("EXPIRED");
  });
});
