import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createServiceBundleAction,
  updateServiceBundleAction,
  deleteServiceBundleAction,
  addBundleItemAction,
  removeBundleItemAction,
  listServiceBundlesAction,
} from "@/modules/agenda/bundle-actions";

const mockPrisma = {
  serviceBundle: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  serviceBundleItem: {
    create: vi.fn(),
    findFirst: vi.fn(),
    delete: vi.fn(),
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

describe("bundle-actions (unit)", () => {
  const tenant = {
    id: "tenant-123",
    slug: "clinica-teste",
    name: "Clínica Teste",
  };

  const service = {
    id: "srv-1",
    name: "Corte Completo",
    priceCents: 5000,
    durationMin: 30,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockBilling.assertTenantCanWrite.mockResolvedValue(undefined);
    mockTenantService.findFirst.mockResolvedValue(service);
  });

  describe("createServiceBundleAction", () => {
    it("recusa nome menor que 3 caracteres", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      const res = await createServiceBundleAction(tenant.slug, {
        name: "Co",
        priceCents: 8000,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Nome do combo deve ter pelo menos 3 caracteres");
      }
    });

    it("cria bundle com sucesso e grava audit log com supportSessionId", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "admin-1" },
        membership: { role: "OWNER" },
        isSupportImpersonation: true,
        supportSessionId: "session-bundle-1",
      });

      mockPrisma.serviceBundle.create.mockResolvedValue({
        id: "bundle-1",
        tenantId: tenant.id,
        name: "Combo Cabelo + Barba",
        priceCents: 8000,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      });

      const res = await createServiceBundleAction(tenant.slug, {
        name: "Combo Cabelo + Barba",
        priceCents: 8000,
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: tenant.id,
            action: "service_bundle.created",
            targetType: "service_bundle",
            targetId: "bundle-1",
            supportSessionId: "session-bundle-1",
            actorRole: "PLATFORM_ADMIN",
            summary: expect.stringContaining("Combo Cabelo + Barba"),
          }),
        }),
      );
    });
  });

  describe("updateServiceBundleAction", () => {
    it("exige justificativa de pelo menos 15 chars se o preço mudar", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      mockPrisma.serviceBundle.findFirst.mockResolvedValue({
        id: "bundle-1",
        tenantId: tenant.id,
        name: "Combo Cabelo + Barba",
        priceCents: 8000,
        isActive: true,
      });

      const resNoReason = await updateServiceBundleAction(tenant.slug, "bundle-1", {
        priceCents: 9000,
      });
      expect(resNoReason.ok).toBe(false);
      if (!resNoReason.ok) {
        expect(resNoReason.error.message).toContain("pelo menos 15 caracteres");
      }

      const resShort = await updateServiceBundleAction(tenant.slug, "bundle-1", {
        priceCents: 9000,
        priceChangeReason: "curto",
      });
      expect(resShort.ok).toBe(false);
    });

    it("atualiza com sucesso quando justificativa é válida", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "admin-1" },
        membership: { role: "OWNER" },
        isSupportImpersonation: true,
        supportSessionId: "session-bundle-up",
      });

      mockPrisma.serviceBundle.findFirst.mockResolvedValue({
        id: "bundle-1",
        tenantId: tenant.id,
        name: "Combo Cabelo + Barba",
        priceCents: 8000,
        isActive: true,
      });

      mockPrisma.serviceBundle.update.mockResolvedValue({
        id: "bundle-1",
        tenantId: tenant.id,
        name: "Combo Cabelo + Barba",
        priceCents: 9500,
        isActive: true,
        items: [],
      });

      const reason = "Aumento de custo de materiais de barbearia";
      const res = await updateServiceBundleAction(tenant.slug, "bundle-1", {
        priceCents: 9500,
        priceChangeReason: reason,
      });

      expect(res.ok).toBe(true);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "service_bundle.price_changed",
            targetType: "service_bundle",
            supportSessionId: "session-bundle-up",
            actorRole: "PLATFORM_ADMIN",
            summary: expect.stringContaining(`Motivo: ${reason}`),
          }),
        }),
      );
    });
  });

  describe("deleteServiceBundleAction", () => {
    it("faz soft delete com isActive = false", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      mockPrisma.serviceBundle.findFirst.mockResolvedValue({
        id: "bundle-1",
        tenantId: tenant.id,
        name: "Combo Especial",
        isActive: true,
      });

      mockPrisma.serviceBundle.update.mockResolvedValue({
        id: "bundle-1",
        isActive: false,
      });

      const res = await deleteServiceBundleAction(tenant.slug, "bundle-1");
      expect(res.ok).toBe(true);

      expect(mockPrisma.serviceBundle.update).toHaveBeenCalledWith({
        where: { id: "bundle-1" },
        data: { isActive: false },
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "service_bundle.deleted",
            targetId: "bundle-1",
          }),
        }),
      );
    });
  });

  describe("addBundleItemAction", () => {
    it("recusa quantidade fora de 1-99", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      const resZero = await addBundleItemAction(tenant.slug, "bundle-1", "srv-1", 0);
      expect(resZero.ok).toBe(false);

      const res100 = await addBundleItemAction(tenant.slug, "bundle-1", "srv-1", 100);
      expect(res100.ok).toBe(false);
    });

    it("adiciona item ao combo com sucesso", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "admin-1" },
        membership: { role: "OWNER" },
        isSupportImpersonation: true,
        supportSessionId: "session-item-add",
      });

      mockPrisma.serviceBundle.findFirst.mockResolvedValue({
        id: "bundle-1",
        name: "Combo Completo",
      });

      mockPrisma.serviceBundleItem.create.mockResolvedValue({
        id: "item-1",
        bundleId: "bundle-1",
        serviceId: service.id,
        quantity: 2,
        order: 1,
        service,
      });

      const res = await addBundleItemAction(tenant.slug, "bundle-1", service.id, 2, 1);
      expect(res.ok).toBe(true);

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "service_bundle.item_added",
            targetId: "bundle-1",
            supportSessionId: "session-item-add",
            actorRole: "PLATFORM_ADMIN",
            summary: expect.stringContaining("2x 'Corte Completo' ao combo 'Combo Completo'"),
          }),
        }),
      );
    });
  });

  describe("removeBundleItemAction", () => {
    it("remove item do combo com sucesso", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "OWNER" },
      });

      mockPrisma.serviceBundleItem.findFirst.mockResolvedValue({
        id: "item-1",
        bundle: { id: "bundle-1", name: "Combo Completo" },
        service: { id: service.id, name: "Corte Completo" },
      });

      mockPrisma.serviceBundleItem.delete.mockResolvedValue({
        id: "item-1",
      });

      const res = await removeBundleItemAction(tenant.slug, "item-1");
      expect(res.ok).toBe(true);

      expect(mockPrisma.serviceBundleItem.delete).toHaveBeenCalledWith({
        where: { id: "item-1" },
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "service_bundle.item_removed",
            targetId: "bundle-1",
            summary: expect.stringContaining("Removeu 'Corte Completo' do combo 'Combo Completo'"),
          }),
        }),
      );
    });
  });

  describe("listServiceBundlesAction", () => {
    it("lista combos da empresa com items", async () => {
      mockGuard.requireTenantMember.mockResolvedValue({
        tenant,
        user: { id: "user-1" },
        membership: { role: "STAFF" },
      });

      mockPrisma.serviceBundle.findMany.mockResolvedValue([
        { id: "bundle-1", name: "Combo 1", items: [] },
      ]);

      const res = await listServiceBundlesAction(tenant.slug);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toHaveLength(1);
      }
    });
  });
});
