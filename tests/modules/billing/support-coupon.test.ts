import { describe, it, expect, vi, beforeEach } from "vitest";
import { applySupportCouponAction } from "@/modules/billing/support-actions";
import * as couponService from "@/modules/billing/coupons";

const mockPrisma = {
  tenant: {
    findUnique: vi.fn(),
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

describe("support-coupon action (unit)", () => {
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

    const res = await applySupportCouponAction(tenant.slug, {
      code: "PROMO50",
      reason: "muito curto",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("O motivo deve ter pelo menos 15 caracteres");
    }
  });

  it("reusa applyCouponToSubscription e registra audit log com actorRole PLATFORM_ADMIN e supportSessionId", async () => {
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "supp", role: "OWNER" },
      user: { id: "admin-1" },
      isSupportImpersonation: true,
      supportSessionId: "session-xyz",
    });

    const applySpy = vi.spyOn(couponService, "applyCouponToSubscription").mockResolvedValue({
      coupon: {
        code: "DESCONTO30",
        description: "Cupom teste",
        kind: "PERCENT",
        value: 30,
        duration: "ONCE",
        durationCycles: null,
        appliesToCycles: ["MONTHLY"],
      },
      pricing: {
        grossCents: 10000,
        discountCents: 3000,
        netCents: 7000,
        cycle: "MONTHLY",
      },
      trialInvoiceRepriced: false,
    });

    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await applySupportCouponAction(tenant.slug, {
      code: "DESCONTO30",
      reason: "Concedido desconto por acordo de suporte comercial",
    });

    expect(res.ok).toBe(true);
    expect(applySpy).toHaveBeenCalledWith(tenant.id, "DESCONTO30");

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "billing.coupon_applied",
          actorRole: "PLATFORM_ADMIN",
          actorUserId: "admin-1",
          supportSessionId: "session-xyz",
          tenantId: tenant.id,
          summary: expect.stringContaining("Suporte aplicou o cupom DESCONTO30"),
        }),
      })
    );
  });
});
