import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createServiceAddonAction,
  updateServiceAddonAction,
  deleteServiceAddonAction,
  listServiceAddonsAction,
} from "@/modules/agenda/addon-actions";

const mockPrisma = {
  serviceAddon: {
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

describe("addon-actions (unit)", () => {
  const tenant = {
    id: "tenant-123",
    slug: "clinica-teste",
    name: "Clínica Teste",
  };

  const service = {
    id: "srv-1",
    name: "Massagem Relaxante",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockBilling.assertTenantCanWrite.mockResolvedValue(undefined);
    mockTenantService.findFirst.mockResolvedValue(service);
  });

  describe("createServiceAddonAction", () => {
    it("recusa nome com menos de 3 caracteres", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      const res = await createServiceAddonAction(tenant.slug, service.id, {
        name: "Ab",
        priceCents: 1500,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Nome do adicional deve ter pelo menos 3 caracteres");
      }
    });

    it("recusa se serviço não for encontrado no tenant", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });
      mockTenantService.findFirst.mockResolvedValue(null);

      const res = await createServiceAddonAction(tenant.slug, "srv-outro", {
        name: "Óleo Essencial",
        priceCents: 1500,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Serviço não encontrado");
      }
    });

    it("cria adicional com sucesso e grava audit log com supportSessionId e PLATFORM_ADMIN quando impersonando", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "admin-99" },
        membership: { role: "OWNER" },
        isSupportImpersonation: true,
        supportSessionId: "session-support-xyz",
      });

      mockPrisma.serviceAddon.create.mockResolvedValue({
        id: "addon-1",
        serviceId: service.id,
        name: "Óleo Essencial",
        priceCents: 1500,
        isRequired: false,
        order: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await createServiceAddonAction(tenant.slug, service.id, {
        name: "Óleo Essencial",
        priceCents: 1500,
        order: 1,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.id).toBe("addon-1");
      }

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: tenant.id,
            actorRole: "PLATFORM_ADMIN",
            actorUserId: "admin-99",
            action: "service_addon.created",
            targetType: "service_addon",
            targetId: "addon-1",
            supportSessionId: "session-support-xyz",
            summary: expect.stringContaining("Óleo Essencial"),
          }),
        }),
      );
    });

    it("cria adicional com sucesso como membro comum (role OWNER, sem supportSessionId)", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "member-1" },
        membership: { role: "OWNER" },
        isSupportImpersonation: false,
      });

      mockPrisma.serviceAddon.create.mockResolvedValue({
        id: "addon-2",
        serviceId: service.id,
        name: "Aroma Lavanda",
        priceCents: 1000,
        isRequired: false,
        order: 2,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await createServiceAddonAction(tenant.slug, service.id, {
        name: "Aroma Lavanda",
        priceCents: 1000,
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: tenant.id,
            actorRole: "OWNER",
            actorUserId: "member-1",
            supportSessionId: null,
          }),
        }),
      );
    });
  });

  describe("updateServiceAddonAction", () => {
    it("exige justificativa de pelo menos 15 chars se o preço mudar", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      mockPrisma.serviceAddon.findFirst.mockResolvedValue({
        id: "addon-1",
        serviceId: service.id,
        name: "Óleo Essencial",
        priceCents: 1500,
        isRequired: false,
        order: 1,
        isActive: true,
        service,
      });

      // Sem justificativa
      const resNoReason = await updateServiceAddonAction(tenant.slug, "addon-1", {
        priceCents: 2000,
      });
      expect(resNoReason.ok).toBe(false);
      if (!resNoReason.ok) {
        expect(resNoReason.error.message).toContain("pelo menos 15 caracteres");
      }

      // Justificativa curta (< 15 chars)
      const resShort = await updateServiceAddonAction(tenant.slug, "addon-1", {
        priceCents: 2000,
        priceChangeReason: "curto",
      });
      expect(resShort.ok).toBe(false);
      if (!resShort.ok) {
        expect(resShort.error.message).toContain("pelo menos 15 caracteres");
      }
    });

    it("atualiza preço quando justificativa tem pelo menos 15 chars e grava no summary", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "admin-1" },
        membership: { role: "OWNER" },
        isSupportImpersonation: true,
        supportSessionId: "session-abc",
      });

      mockPrisma.serviceAddon.findFirst.mockResolvedValue({
        id: "addon-1",
        serviceId: service.id,
        name: "Óleo Essencial",
        priceCents: 1500,
        isRequired: false,
        order: 1,
        isActive: true,
        service,
      });

      mockPrisma.serviceAddon.update.mockResolvedValue({
        id: "addon-1",
        serviceId: service.id,
        name: "Óleo Essencial",
        priceCents: 2200,
        isRequired: false,
        order: 1,
        isActive: true,
      });

      const reason = "Reajuste anual de insumos da clínica";
      const res = await updateServiceAddonAction(tenant.slug, "addon-1", {
        priceCents: 2200,
        priceChangeReason: reason,
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "service_addon.price_changed",
            supportSessionId: "session-abc",
            actorRole: "PLATFORM_ADMIN",
            summary: expect.stringContaining(`Motivo: ${reason}`),
          }),
        }),
      );
    });

    it("atualiza outros campos sem exigir justificativa de preço", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      mockPrisma.serviceAddon.findFirst.mockResolvedValue({
        id: "addon-1",
        serviceId: service.id,
        name: "Óleo Essencial",
        priceCents: 1500,
        isRequired: false,
        order: 1,
        isActive: true,
        service,
      });

      mockPrisma.serviceAddon.update.mockResolvedValue({
        id: "addon-1",
        serviceId: service.id,
        name: "Óleo Essencial Premium",
        priceCents: 1500,
        isRequired: true,
        order: 2,
        isActive: true,
      });

      const res = await updateServiceAddonAction(tenant.slug, "addon-1", {
        name: "Óleo Essencial Premium",
        isRequired: true,
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "service_addon.updated",
          }),
        }),
      );
    });
  });

  describe("deleteServiceAddonAction", () => {
    it("faz soft delete com isActive = false e grava audit log", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "admin-1" },
        membership: { role: "OWNER" },
        isSupportImpersonation: true,
        supportSessionId: "session-del-1",
      });

      mockPrisma.serviceAddon.findFirst.mockResolvedValue({
        id: "addon-1",
        name: "Toalha Quente",
        isActive: true,
      });

      mockPrisma.serviceAddon.update.mockResolvedValue({
        id: "addon-1",
        isActive: false,
      });

      const res = await deleteServiceAddonAction(tenant.slug, "addon-1");
      expect(res.ok).toBe(true);

      expect(mockPrisma.serviceAddon.update).toHaveBeenCalledWith({
        where: { id: "addon-1" },
        data: { isActive: false },
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "service_addon.deleted",
            targetId: "addon-1",
            supportSessionId: "session-del-1",
            actorRole: "PLATFORM_ADMIN",
            summary: expect.stringContaining("Toalha Quente"),
          }),
        }),
      );
    });
  });

  describe("listServiceAddonsAction", () => {
    it("lista adicionais do serviço", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "STAFF" },
      });

      mockPrisma.serviceAddon.findMany.mockResolvedValue([
        { id: "addon-1", name: "Opção 1", order: 0 },
        { id: "addon-2", name: "Opção 2", order: 1 },
      ]);

      const res = await listServiceAddonsAction(tenant.slug, service.id);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toHaveLength(2);
      }
    });
  });
});
