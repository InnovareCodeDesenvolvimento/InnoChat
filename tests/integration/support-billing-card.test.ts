import { describe, it, expect, vi, beforeEach } from "vitest";
import { listSupportSessionsAction } from "@/modules/billing/support-actions";

const mockPrisma = {
  supportSession: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
};

const mockGuard = {
  requireTenantMember: vi.fn(),
};

vi.mock("@/lib/db/prisma", () => ({
  getPrisma: () => mockPrisma,
}));

vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: (...args: unknown[]) => mockGuard.requireTenantMember(...args),
}));

describe("support-billing-card query (unit/integration)", () => {
  const tenant = {
    id: "tenant-123",
    slug: "clinica-teste",
    name: "Clínica Teste",
    timezone: "America/Sao_Paulo",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "m-1", role: "OWNER" },
      user: { id: "owner-1" },
    });
  });

  it("retorna lista paginada de sessões de suporte com dados do admin e status", async () => {
    const now = new Date();
    mockPrisma.supportSession.count.mockResolvedValue(15);
    mockPrisma.supportSession.findMany.mockResolvedValue([
      {
        id: "sess-1",
        tenantId: tenant.id,
        reason: "Verificação de inconsistência de faturas pendentes",
        startedAt: new Date(now.getTime() - 10 * 60 * 1000),
        expiresAt: new Date(now.getTime() + 50 * 60 * 1000),
        closedAt: null,
        closeReason: null,
        admin: {
          name: "Carlos Suporte",
          email: "carlos@innochat.com.br",
        },
      },
      {
        id: "sess-2",
        tenantId: tenant.id,
        reason: "Suporte comercial para estender trial",
        startedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        expiresAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
        closedAt: new Date(now.getTime() - 23 * 30 * 60 * 1000),
        closeReason: "EXITED",
        admin: {
          name: "Ana Suporte",
          email: "ana@innochat.com.br",
        },
      },
    ]);

    const res = await listSupportSessionsAction(tenant.slug, { page: 1, pageSize: 10 });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.totalItems).toBe(15);
      expect(res.data.totalPages).toBe(2);
      expect(res.data.items).toHaveLength(2);

      const [s1, s2] = res.data.items;
      expect(s1.adminName).toBe("Carlos Suporte");
      expect(s1.status).toBe("ACTIVE");
      expect(s2.adminName).toBe("Ana Suporte");
      expect(s2.status).toBe("CLOSED");
    }
  });

  it("calcula status EXPIRED caso a sessão tenha passado de expiresAt sem closedAt", async () => {
    const now = new Date();
    mockPrisma.supportSession.count.mockResolvedValue(1);
    mockPrisma.supportSession.findMany.mockResolvedValue([
      {
        id: "sess-old",
        tenantId: tenant.id,
        reason: "Investigação de webhook do n8n",
        startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
        closedAt: null,
        closeReason: null,
        admin: {
          name: "Admin",
          email: "admin@innochat.com.br",
        },
      },
    ]);

    const res = await listSupportSessionsAction(tenant.slug);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.items[0].status).toBe("EXPIRED");
    }
  });
});
