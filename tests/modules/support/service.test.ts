import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  startSupportSession,
  validateSupportSession,
  closeSupportSession,
  signSupportCookiePayload,
  verifySupportCookiePayload,
  SUPPORT_SESSION_TTL_MS,
  type SupportCookiePayload,
} from "@/modules/support/service";
import { DomainError } from "@/lib/errors";

const mockPrisma = {
  user: {
    findUnique: vi.fn(),
  },
  tenant: {
    findUnique: vi.fn(),
  },
  supportSession: {
    updateMany: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
  },
};

vi.mock("@/lib/db/prisma", () => ({
  getPrisma: () => mockPrisma,
}));

describe("Support Service (unit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = "super-secret-key-at-least-16-bytes";
  });

  describe("signSupportCookiePayload / verifySupportCookiePayload", () => {
    it("assina e verifica payload íntegro com sucesso", () => {
      const payload: SupportCookiePayload = {
        sessionId: "session-uuid",
        adminUserId: "admin-1",
        tenantId: "tenant-1",
        tenantSlug: "clinica-exemplo",
        exp: Date.now() + 3600_000,
      };

      const cookieValue = signSupportCookiePayload(payload);
      expect(typeof cookieValue).toBe("string");
      expect(cookieValue.includes(".")).toBe(true);

      const verified = verifySupportCookiePayload(cookieValue);
      expect(verified).toEqual(payload);
    });

    it("recusa cookie com assinatura adulterada", () => {
      const payload: SupportCookiePayload = {
        sessionId: "session-uuid",
        adminUserId: "admin-1",
        tenantId: "tenant-1",
        tenantSlug: "clinica-exemplo",
        exp: Date.now() + 3600_000,
      };

      const cookieValue = signSupportCookiePayload(payload);
      const [data, sig] = cookieValue.split(".");
      const tampered = `${data}.${sig.slice(0, -1)}x`;

      const verified = verifySupportCookiePayload(tampered);
      expect(verified).toBeNull();
    });

    it("recusa cookie com payload quebrado ou formato incorreto", () => {
      expect(verifySupportCookiePayload("not-valid")).toBeNull();
      expect(verifySupportCookiePayload("not.valid.jwt")).toBeNull();
    });
  });

  describe("startSupportSession", () => {
    it("lança FORBIDDEN se o usuário não for isPlatformAdmin", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        isPlatformAdmin: false,
        totpEnabledAt: new Date(),
      });

      await expect(
        startSupportSession({
          adminUserId: "user-1",
          tenantId: "tenant-1",
          reason: "Atendimento técnico ao cliente",
          ip: null,
          userAgent: null,
        })
      ).rejects.toThrowError(DomainError);
    });

    it("lança TWO_FACTOR_SETUP_REQUIRED se o admin não tiver 2FA ativa", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin-1",
        isPlatformAdmin: true,
        totpEnabledAt: null,
      });

      await expect(
        startSupportSession({
          adminUserId: "admin-1",
          tenantId: "tenant-1",
          reason: "Atendimento técnico ao cliente",
          ip: null,
          userAgent: null,
        })
      ).rejects.toThrowError(DomainError);
    });

    it("lança NOT_FOUND se o tenant não existir ou estiver inativo", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin-1",
        isPlatformAdmin: true,
        totpEnabledAt: new Date(),
      });
      mockPrisma.tenant.findUnique.mockResolvedValue(null);

      await expect(
        startSupportSession({
          adminUserId: "admin-1",
          tenantId: "tenant-1",
          reason: "Atendimento técnico ao cliente",
          ip: null,
          userAgent: null,
        })
      ).rejects.toThrowError(DomainError);

      mockPrisma.tenant.findUnique.mockResolvedValue({
        id: "tenant-1",
        slug: "empresa",
        subscription: { status: "CANCELED" },
      });

      await expect(
        startSupportSession({
          adminUserId: "admin-1",
          tenantId: "tenant-1",
          reason: "Atendimento técnico ao cliente",
          ip: null,
          userAgent: null,
        })
      ).rejects.toThrowError(DomainError);
    });

    it("lança INVALID_REASON se o motivo for curto (<15) ou longo (>500)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin-1",
        isPlatformAdmin: true,
        totpEnabledAt: new Date(),
      });
      mockPrisma.tenant.findUnique.mockResolvedValue({
        id: "tenant-1",
        slug: "empresa",
        subscription: { status: "ACTIVE" },
      });

      await expect(
        startSupportSession({
          adminUserId: "admin-1",
          tenantId: "tenant-1",
          reason: "curto",
          ip: null,
          userAgent: null,
        })
      ).rejects.toThrowError(DomainError);

      await expect(
        startSupportSession({
          adminUserId: "admin-1",
          tenantId: "tenant-1",
          reason: "a".repeat(501),
          ip: null,
          userAgent: null,
        })
      ).rejects.toThrowError(DomainError);
    });

    it("com admin OK e tenant ativo: revoga sessões anteriores, cria sessão e retorna cookie", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin-1",
        isPlatformAdmin: true,
        totpEnabledAt: new Date(),
      });
      mockPrisma.tenant.findUnique.mockResolvedValue({
        id: "tenant-1",
        slug: "empresa",
        subscription: { status: "ACTIVE" },
      });
      mockPrisma.supportSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.supportSession.create.mockResolvedValue({
        id: "session-123",
        tenantId: "tenant-1",
        adminUserId: "admin-1",
        reason: "Investigação de agendamentos duplicados",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + SUPPORT_SESSION_TTL_MS),
      });

      const res = await startSupportSession({
        adminUserId: "admin-1",
        tenantId: "tenant-1",
        reason: "Investigação de agendamentos duplicados",
        ip: null,
        userAgent: null,
      });

      expect(res.sessionId).toBe("session-123");
      expect(res.tenantSlug).toBe("empresa");
      expect(res.cookieValue).toBeDefined();

      // Confere que fechou sessões anteriores do admin
      expect(mockPrisma.supportSession.updateMany).toHaveBeenCalledWith({
        where: { adminUserId: "admin-1", closedAt: null },
        data: expect.objectContaining({ closeReason: "REVOKED" }),
      });

      // Confere que inseriu nova sessão
      expect(mockPrisma.supportSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          adminUserId: "admin-1",
          tenantId: "tenant-1",
          reason: "Investigação de agendamentos duplicados",
        }),
      });
    });
  });

  describe("validateSupportSession", () => {
    it("retorna ok:false reason:INVALID para cookie inválido", async () => {
      const res = await validateSupportSession({ cookieValue: "invalid-cookie" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("INVALID");
      }
    });

    it("retorna ok:false reason:EXPIRED e atualiza banco se expiresAt estiver no passado", async () => {
      const pastExp = Date.now() - 1000;
      const cookieValue = signSupportCookiePayload({
        sessionId: "sess-past",
        adminUserId: "admin-1",
        tenantId: "tenant-1",
        tenantSlug: "empresa",
        exp: pastExp,
      });

      mockPrisma.supportSession.findUnique.mockResolvedValue({
        id: "sess-past",
        tenantId: "tenant-1",
        adminUserId: "admin-1",
        expiresAt: new Date(pastExp),
        closedAt: null,
        admin: { id: "admin-1", isPlatformAdmin: true, totpEnabledAt: new Date() },
        tenant: { id: "tenant-1", slug: "empresa", subscription: { status: "ACTIVE" } },
      });
      mockPrisma.supportSession.updateMany.mockResolvedValue({ count: 1 });

      const res = await validateSupportSession({ cookieValue });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("EXPIRED");
        expect(res.tenantId).toBe("tenant-1");
      }

      expect(mockPrisma.supportSession.updateMany).toHaveBeenCalledWith({
        where: { id: "sess-past", closedAt: null },
        data: expect.objectContaining({ closeReason: "EXPIRED" }),
      });
    });

    it("retorna ok:false reason:REVOKED se admin perdeu isPlatformAdmin ou 2FA", async () => {
      const futureExp = Date.now() + 100000;
      const cookieValue = signSupportCookiePayload({
        sessionId: "sess-rev",
        adminUserId: "admin-1",
        tenantId: "tenant-1",
        tenantSlug: "empresa",
        exp: futureExp,
      });

      mockPrisma.supportSession.findUnique.mockResolvedValue({
        id: "sess-rev",
        tenantId: "tenant-1",
        adminUserId: "admin-1",
        expiresAt: new Date(futureExp),
        closedAt: null,
        admin: { id: "admin-1", isPlatformAdmin: false, totpEnabledAt: new Date() },
        tenant: { id: "tenant-1", slug: "empresa", subscription: { status: "ACTIVE" } },
      });
      mockPrisma.supportSession.updateMany.mockResolvedValue({ count: 1 });

      const res = await validateSupportSession({ cookieValue });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("REVOKED");
      }

      expect(mockPrisma.supportSession.updateMany).toHaveBeenCalledWith({
        where: { id: "sess-rev", closedAt: null },
        data: expect.objectContaining({ closeReason: "REVOKED" }),
      });
    });

    it("retorna ok:true com dados da sessão para sessão válida e ativa", async () => {
      const futureExp = Date.now() + 100000;
      const cookieValue = signSupportCookiePayload({
        sessionId: "sess-ok",
        adminUserId: "admin-1",
        tenantId: "tenant-1",
        tenantSlug: "empresa",
        exp: futureExp,
      });

      mockPrisma.supportSession.findUnique.mockResolvedValue({
        id: "sess-ok",
        tenantId: "tenant-1",
        adminUserId: "admin-1",
        expiresAt: new Date(futureExp),
        closedAt: null,
        admin: { id: "admin-1", isPlatformAdmin: true, totpEnabledAt: new Date() },
        tenant: { id: "tenant-1", slug: "empresa", subscription: { status: "ACTIVE" } },
      });

      const res = await validateSupportSession({ cookieValue });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.sessionId).toBe("sess-ok");
        expect(res.adminUserId).toBe("admin-1");
        expect(res.tenantSlug).toBe("empresa");
      }
    });
  });

  describe("closeSupportSession", () => {
    it("executa updateMany idempotente", async () => {
      mockPrisma.supportSession.updateMany.mockResolvedValue({ count: 1 });

      const res1 = await closeSupportSession({ sessionId: "sess-1", reason: "EXITED" });
      expect(res1.closed).toBe(true);

      mockPrisma.supportSession.updateMany.mockResolvedValue({ count: 0 });
      const res2 = await closeSupportSession({ sessionId: "sess-1", reason: "EXITED" });
      expect(res2.closed).toBe(false);
    });
  });
});
