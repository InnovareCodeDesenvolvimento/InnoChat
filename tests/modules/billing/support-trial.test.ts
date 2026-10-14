import { describe, it, expect, vi, beforeEach } from "vitest";
import { extendTrialAction } from "@/modules/billing/support-actions";

const mockPrisma = {
  tenant: {
    findUnique: vi.fn(),
  },
  subscription: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  invoice: {
    updateMany: vi.fn(),
  },
  billingEvent: {
    create: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
};

const mockGuard = {
  requireTenantMember: vi.fn(),
  requirePlatformAdmin: vi.fn(),
};

vi.mock("@/lib/db/prisma", () => ({
  getPrisma: () => mockPrisma,
}));

vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: (...args: unknown[]) => mockGuard.requireTenantMember(...args),
  requirePlatformAdmin: (...args: unknown[]) => mockGuard.requirePlatformAdmin(...args),
}));

describe("support-trial action (unit)", () => {
  const tenant = {
    id: "tenant-123",
    slug: "clinica-teste",
    name: "Clínica Teste",
    timezone: "America/Sao_Paulo",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.tenant.findUnique.mockResolvedValue(tenant);
  });

  it("recusa motivo menor que 15 caracteres", async () => {
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "supp", role: "OWNER" },
      user: { id: "admin-1" },
      isSupportImpersonation: true,
      supportSessionId: "session-abc",
    });

    const res = await extendTrialAction(tenant.slug, {
      days: 5,
      reason: "curto",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("O motivo deve ter pelo menos 15 caracteres");
    }
  });

  it("recusa dias fora do intervalo 1 a 30", async () => {
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "supp", role: "OWNER" },
      user: { id: "admin-1" },
      isSupportImpersonation: true,
      supportSessionId: "session-abc",
    });

    const resZero = await extendTrialAction(tenant.slug, {
      days: 0,
      reason: "Motivo explicativo com mais de 15 caracteres",
    });
    expect(resZero.ok).toBe(false);

    const resTooLarge = await extendTrialAction(tenant.slug, {
      days: 35,
      reason: "Motivo explicativo com mais de 15 caracteres",
    });
    expect(resTooLarge.ok).toBe(false);
  });

  it("recusa se a empresa não estiver em TRIALING", async () => {
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "supp", role: "OWNER" },
      user: { id: "admin-1" },
      isSupportImpersonation: true,
      supportSessionId: "session-abc",
    });

    mockPrisma.subscription.findUnique.mockResolvedValue({
      id: "sub-1",
      status: "ACTIVE",
      trialEndsAt: null,
      createdAt: new Date(),
    });

    const res = await extendTrialAction(tenant.slug, {
      days: 5,
      reason: "Motivo explicativo com mais de 15 caracteres",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_STATE");
    }
  });

  it("recusa se a extensão ultrapassar 30 dias desde createdAt (regra do dono)", async () => {
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "supp", role: "OWNER" },
      user: { id: "admin-1" },
      isSupportImpersonation: true,
      supportSessionId: "session-abc",
    });

    const now = new Date();
    // Conta criada há 25 dias
    const createdAt = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000);
    // Trial atual vence hoje
    const trialEndsAt = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

    mockPrisma.subscription.findUnique.mockResolvedValue({
      id: "sub-1",
      status: "TRIALING",
      trialEndsAt,
      createdAt,
    });

    // Tentar estender +10 dias passaria dos 30 dias (25 + 1 + 10 = 36 dias desde createdAt)
    const res = await extendTrialAction(tenant.slug, {
      days: 10,
      reason: "Motivo explicativo com mais de 15 caracteres",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("TRIAL_LIMIT_EXCEEDED");
    }
  });

  it("estende o trial com sucesso, atualiza fatura e grava auditoria com supportSessionId", async () => {
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "supp", role: "OWNER" },
      user: { id: "admin-1" },
      isSupportImpersonation: true,
      supportSessionId: "session-abc",
    });

    const now = new Date();
    // Conta criada há 2 dias
    const createdAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    // Trial vence amanhã
    const trialEndsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    mockPrisma.subscription.findUnique.mockResolvedValue({
      id: "sub-1",
      status: "TRIALING",
      trialEndsAt,
      createdAt,
    });
    mockPrisma.subscription.update.mockResolvedValue({});
    mockPrisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockPrisma.billingEvent.create.mockResolvedValue({});

    const res = await extendTrialAction(tenant.slug, {
      days: 7,
      reason: "Cliente solicitou mais tempo para testar integrações",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.trialEndsAt).toBeDefined();
    }

    expect(mockPrisma.subscription.update).toHaveBeenCalled();
    expect(mockPrisma.invoice.updateMany).toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "billing.trial_extended",
          actorRole: "PLATFORM_ADMIN",
          actorUserId: "admin-1",
          supportSessionId: "session-abc",
          tenantId: tenant.id,
        }),
      })
    );
  });
});
