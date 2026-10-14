import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPricingRuleAction,
  updatePricingRuleAction,
  deletePricingRuleAction,
  listPricingRulesAction,
  validatePricingRuleConfig,
} from "@/modules/agenda/pricing-rule-actions";

const mockPrisma = {
  pricingRule: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
};

const mockTenantService = {
  findFirst: vi.fn(),
};

const mockForTenant = vi.fn((_tId?: string) => ({
  service: mockTenantService,
}));

const mockGuard = {
  requireTenantMember: vi.fn(),
};

const mockBilling = {
  assertTenantCanWrite: vi.fn(),
};

vi.mock("@/lib/db/prisma", () => ({
  getPrisma: () => mockPrisma,
}));

vi.mock("@/lib/db/tenant-client", () => ({
  forTenant: (tId: string) => mockForTenant(tId),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: (...args: unknown[]) => mockGuard.requireTenantMember(...args),
}));

vi.mock("@/modules/billing/service", () => ({
  assertTenantCanWrite: (...args: unknown[]) => mockBilling.assertTenantCanWrite(...args),
}));

describe("pricing-rule-actions (unit)", () => {
  const tenant = {
    id: "tenant-123",
    slug: "clinica-teste",
    name: "Clínica Teste",
  };

  const service = {
    id: "srv-1",
    name: "Corte Masculino",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockBilling.assertTenantCanWrite.mockResolvedValue(undefined);
    mockTenantService.findFirst.mockResolvedValue(service);
  });

  describe("validatePricingRuleConfig", () => {
    it("valida WEEKDAY_OVERRIDE com sucesso", () => {
      const valid = validatePricingRuleConfig("WEEKDAY_OVERRIDE", {
        weekdays: [1, 2, 3],
        priceCents: 4500,
      });
      expect(valid).toEqual({ weekdays: [1, 2, 3], priceCents: 4500 });

      expect(() =>
        validatePricingRuleConfig("WEEKDAY_OVERRIDE", { weekdays: [], priceCents: 4500 }),
      ).toThrow();
    });

    it("valida HOUR_OVERRIDE com sucesso", () => {
      const valid = validatePricingRuleConfig("HOUR_OVERRIDE", {
        startTime: "09:00",
        endTime: "12:00",
        priceCents: 4000,
      });
      expect(valid).toEqual({ startTime: "09:00", endTime: "12:00", priceCents: 4000 });

      expect(() =>
        validatePricingRuleConfig("HOUR_OVERRIDE", { startTime: "9:00", endTime: "12:00", priceCents: 4000 }),
      ).toThrow();
    });

    it("valida DURATION_OVERRIDE com sucesso", () => {
      const valid = validatePricingRuleConfig("DURATION_OVERRIDE", {
        durationMin: 60,
        priceCents: 9000,
      });
      expect(valid).toEqual({ durationMin: 60, priceCents: 9000 });
    });

    it("valida TIER com sucesso", () => {
      const valid = validatePricingRuleConfig("TIER", {
        tiers: [
          { upToMin: 30, priceCents: 5000 },
          { upToMin: 60, priceCents: 8000 },
        ],
      });
      expect(valid.tiers).toHaveLength(2);
    });
  });

  describe("createPricingRuleAction", () => {
    it("recusa tipo de regra inválido", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      const res = await createPricingRuleAction(tenant.slug, {
        kind: "INVALIDO",
        config: {},
      });

      expect(res.ok).toBe(false);
    });

    it("recusa serviço de outro tenant", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });
      mockTenantService.findFirst.mockResolvedValue(null);

      const res = await createPricingRuleAction(tenant.slug, {
        serviceId: "srv-outro",
        kind: "WEEKDAY_OVERRIDE",
        config: { weekdays: [1], priceCents: 3000 },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Serviço não encontrado");
      }
    });

    it("cria regra geral (serviceId nulo) como suporte e grava audit log com supportSessionId", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "admin-1" },
        membership: { role: "OWNER" },
        isSupportImpersonation: true,
        supportSessionId: "session-rule-1",
      });

      mockPrisma.pricingRule.create.mockResolvedValue({
        id: "rule-1",
        tenantId: tenant.id,
        serviceId: null,
        kind: "WEEKDAY_OVERRIDE",
        config: { weekdays: [1, 2], priceCents: 3500 },
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        service: null,
      });

      const res = await createPricingRuleAction(tenant.slug, {
        kind: "WEEKDAY_OVERRIDE",
        config: { weekdays: [1, 2], priceCents: 3500 },
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: tenant.id,
            action: "pricing_rule.created",
            targetType: "pricing_rule",
            targetId: "rule-1",
            supportSessionId: "session-rule-1",
            actorRole: "PLATFORM_ADMIN",
            summary: expect.stringContaining("WEEKDAY_OVERRIDE"),
          }),
        }),
      );
    });
  });

  describe("updatePricingRuleAction", () => {
    it("recusa alteração de preço se justificativa tiver menos de 15 caracteres", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      mockPrisma.pricingRule.findFirst.mockResolvedValue({
        id: "rule-1",
        tenantId: tenant.id,
        kind: "WEEKDAY_OVERRIDE",
        config: { weekdays: [1], priceCents: 3000 },
        isActive: true,
      });

      const res = await updatePricingRuleAction(tenant.slug, "rule-1", {
        config: { weekdays: [1], priceCents: 4000 },
        priceChangeReason: "curto",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("pelo menos 15 caracteres");
      }
    });

    it("atualiza com sucesso quando justificativa é válida", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "admin-1" },
        membership: { role: "OWNER" },
        isSupportImpersonation: true,
        supportSessionId: "session-rule-up",
      });

      mockPrisma.pricingRule.findFirst.mockResolvedValue({
        id: "rule-1",
        tenantId: tenant.id,
        kind: "WEEKDAY_OVERRIDE",
        config: { weekdays: [1], priceCents: 3000 },
        isActive: true,
      });

      mockPrisma.pricingRule.update.mockResolvedValue({
        id: "rule-1",
        tenantId: tenant.id,
        kind: "WEEKDAY_OVERRIDE",
        config: { weekdays: [1], priceCents: 4000 },
        isActive: true,
      });

      const reason = "Promoção de terça-feira encerrada";
      const res = await updatePricingRuleAction(tenant.slug, "rule-1", {
        config: { weekdays: [1], priceCents: 4000 },
        priceChangeReason: reason,
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "pricing_rule.updated",
            targetType: "pricing_rule",
            targetId: "rule-1",
            supportSessionId: "session-rule-up",
            actorRole: "PLATFORM_ADMIN",
            summary: expect.stringContaining(`Motivo: ${reason}`),
          }),
        }),
      );
    });
  });

  describe("deletePricingRuleAction", () => {
    it("faz soft delete com isActive = false e grava audit log", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      mockPrisma.pricingRule.findFirst.mockResolvedValue({
        id: "rule-1",
        tenantId: tenant.id,
        kind: "TIER",
        isActive: true,
      });

      mockPrisma.pricingRule.update.mockResolvedValue({
        id: "rule-1",
        isActive: false,
      });

      const res = await deletePricingRuleAction(tenant.slug, "rule-1");
      expect(res.ok).toBe(true);

      expect(mockPrisma.pricingRule.update).toHaveBeenCalledWith({
        where: { id: "rule-1" },
        data: { isActive: false },
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "pricing_rule.deleted",
            targetId: "rule-1",
          }),
        }),
      );
    });
  });

  describe("listPricingRulesAction", () => {
    it("lista regras de preço do tenant", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "STAFF" },
      });

      mockPrisma.pricingRule.findMany.mockResolvedValue([
        { id: "rule-1", kind: "WEEKDAY_OVERRIDE" },
      ]);

      const res = await listPricingRulesAction(tenant.slug);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toHaveLength(1);
      }
    });
  });
});
