import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const session = { adminId: "" };
vi.mock("@/lib/auth/guards", () => ({
  requirePlatformAdmin: async () => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.adminId) throw new DomainError("FORBIDDEN", "Requer acesso de administrador da plataforma.");
    return { id: session.adminId };
  },
}));

import {
  listRescueLeadsAction,
  getRescueLeadDetailAction,
  toggleRescueEnabledAction,
  pauseRescueLeadAction,
  resumeRescueLeadAction,
  markRescueLeadConvertedAction,
  resendRescueMessageAction,
  getRescueSettingsAction,
} from "@/modules/rescue/admin-actions";
import { buildRescueLeadsCsv } from "@/modules/rescue/csv";

const prisma = getPrisma();
const runId = randomUUID().slice(0, 8);
const tenantIds: string[] = [];
const userIds: string[] = [];
const leadIds: string[] = [];

async function createTestWorld() {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `it-rescue-${runId}-${tenantIds.length}`,
      name: `Empresa Resgate ${tenantIds.length}`,
      timezone: "America/Sao_Paulo",
    },
  });
  tenantIds.push(tenant.id);

  const user = await prisma.user.create({
    data: {
      email: `lead-user-${runId}-${userIds.length}@example.test`,
      name: `Lead Nome ${userIds.length}`,
      passwordHash: "hash123",
    },
  });
  userIds.push(user.id);

  const phoneE164 = `558499${String(userIds.length).padStart(6, "0")}`;
  const now = new Date();

  const lead = await prisma.rescueLead.create({
    data: {
      userId: user.id,
      tenantId: tenant.id,
      phoneE164,
      status: "PENDING",
      step1ScheduledAt: new Date(now.getTime() + 24 * 3600 * 1000),
      step2ScheduledAt: new Date(now.getTime() + 96 * 3600 * 1000),
      nextRunAt: new Date(now.getTime() + 24 * 3600 * 1000),
    },
  });
  leadIds.push(lead.id);

  return { tenant, user, lead };
}

describe("Admin Rescue Leads (Integration Test)", () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await prisma.user.create({
      data: {
        email: `admin-rescue-${randomUUID().slice(0, 8)}@example.test`,
        name: "Admin Resgate",
        passwordHash: "adminpass",
        isPlatformAdmin: true,
        totpEnabledAt: new Date(),
        totpSecretEnc: "enc:v1:fake",
      },
    });
    userIds.push(admin.id);
    adminId = admin.id;
    session.adminId = adminId;
  });

  afterEach(async () => {
    session.adminId = "";
  });

  afterAll(async () => {
    if (leadIds.length > 0) {
      await prisma.rescueLead.deleteMany({ where: { id: { in: leadIds } } }).catch(() => undefined);
    }
    if (tenantIds.length > 0) {
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    }
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it("lista leads com paginação e filtro por status", async () => {
    const { lead } = await createTestWorld();

    const res = await listRescueLeadsAction({ page: 1, pageSize: 25, status: "PENDING" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.total).toBeGreaterThanOrEqual(1);
    const found = res.data.items.find((item) => item.id === lead.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("PENDING");
    expect(found?.userName).toContain("Lead Nome");
  });

  it("busca leads por termo de texto e telefone", async () => {
    const { lead, user } = await createTestWorld();

    const resName = await listRescueLeadsAction({ search: user.name ?? "" });
    expect(resName.ok).toBe(true);
    if (resName.ok) {
      expect(resName.data.items.some((i) => i.id === lead.id)).toBe(true);
    }

    const resPhone = await listRescueLeadsAction({ search: lead.phoneE164 });
    expect(resPhone.ok).toBe(true);
    if (resPhone.ok) {
      expect(resPhone.data.items.some((i) => i.id === lead.id)).toBe(true);
    }
  });

  it("obtém detalhes completos do lead e retorna 404 para inexistente", async () => {
    const { lead, user, tenant } = await createTestWorld();

    const detail = await getRescueLeadDetailAction(lead.id);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.data.id).toBe(lead.id);
      expect(detail.data.userName).toBe(user.name);
      expect(detail.data.tenantName).toBe(tenant.name);
      expect(Array.isArray(detail.data.auditLogs)).toBe(true);
    }

    const notFoundRes = await getRescueLeadDetailAction("lead-inexistente-123");
    expect(notFoundRes.ok).toBe(false);
    if (!notFoundRes.ok) {
      expect(notFoundRes.error.code).toBe("NOT_FOUND");
    }
  });

  it("aciona o kill switch global com auditoria e valida motivo mínimo de 15 chars", async () => {
    // Rejeita motivo curto
    const shortReasonRes = await toggleRescueEnabledAction(false, "muito curto");
    expect(shortReasonRes.ok).toBe(false);

    // Pausa a régua com motivo válido
    const toggleOff = await toggleRescueEnabledAction(
      false,
      "Pausa emergencial para manutenção na infraestrutura do WhatsApp",
    );
    expect(toggleOff.ok).toBe(true);
    if (toggleOff.ok) {
      expect(toggleOff.data.enabled).toBe(false);
    }

    const settings = await getRescueSettingsAction();
    expect(settings.ok).toBe(true);
    if (settings.ok) {
      expect(settings.data.rescueWhatsappEnabled).toBe(false);
    }

    // Verifica se gravou auditoria
    const audit = await prisma.auditLog.findFirst({
      where: {
        targetType: "PlatformSettings",
        action: "rescue.disabled",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorRole).toBe("PLATFORM_ADMIN");

    // Reativa a régua com motivo válido
    const toggleOn = await toggleRescueEnabledAction(
      true,
      "Manutenção concluída com sucesso, retomando régua",
    );
    expect(toggleOn.ok).toBe(true);
    if (toggleOn.ok) {
      expect(toggleOn.data.enabled).toBe(true);
    }
  });

  it("pausa e retoma um lead individual com registro de auditoria", async () => {
    const { lead } = await createTestWorld();

    // Pausar lead
    const pauseRes = await pauseRescueLeadAction(lead.id, "Cliente pediu contato telefônico exclusivo");
    expect(pauseRes.ok).toBe(true);
    if (pauseRes.ok) {
      expect(pauseRes.data.status).toBe("SKIPPED");
    }

    const checkPaused = await prisma.rescueLead.findUnique({ where: { id: lead.id } });
    expect(checkPaused?.status).toBe("SKIPPED");
    expect(checkPaused?.nextRunAt).toBeNull();

    // Auditoria da pausa
    const auditPause = await prisma.auditLog.findFirst({
      where: {
        targetType: "RescueLead",
        targetId: lead.id,
        action: "rescue.lead_paused",
      },
    });
    expect(auditPause).not.toBeNull();
    expect(auditPause?.actorRole).toBe("PLATFORM_ADMIN");

    // Retomar lead
    const resumeRes = await resumeRescueLeadAction(lead.id, "Retomando envios normais a pedido da gerência");
    expect(resumeRes.ok).toBe(true);
    if (resumeRes.ok) {
      expect(resumeRes.data.status).toBe("PENDING");
    }

    const checkResumed = await prisma.rescueLead.findUnique({ where: { id: lead.id } });
    expect(checkResumed?.status).toBe("PENDING");
    expect(checkResumed?.nextRunAt).not.toBeNull();

    // Auditoria da retomada
    const auditResume = await prisma.auditLog.findFirst({
      where: {
        targetType: "RescueLead",
        targetId: lead.id,
        action: "rescue.lead_resumed",
      },
    });
    expect(auditResume).not.toBeNull();
  });

  it("marca lead como convertido manualmente com motivo e auditoria", async () => {
    const { lead } = await createTestWorld();

    const convertRes = await markRescueLeadConvertedAction(
      lead.id,
      "Cliente acessou a plataforma e agendou o primeiro serviço por telefone",
    );
    expect(convertRes.ok).toBe(true);
    if (convertRes.ok) {
      expect(convertRes.data.status).toBe("CONVERTED");
    }

    const checkConverted = await prisma.rescueLead.findUnique({ where: { id: lead.id } });
    expect(checkConverted?.status).toBe("CONVERTED");
    expect(checkConverted?.convertedAt).not.toBeNull();
    expect(checkConverted?.nextRunAt).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: {
        targetType: "RescueLead",
        targetId: lead.id,
        action: "rescue.lead_converted_manual",
      },
    });
    expect(audit).not.toBeNull();
  });

  it("solicita reenvio imediato de mensagem para o lead", async () => {
    const { lead } = await createTestWorld();

    const resendRes = await resendRescueMessageAction(
      lead.id,
      "Solicitando novo envio imediato após teste de conectividade",
    );
    expect(resendRes.ok).toBe(true);
    if (resendRes.ok) {
      expect(resendRes.data.nextRunAt).toBeDefined();
    }

    const checkResend = await prisma.rescueLead.findUnique({ where: { id: lead.id } });
    expect(checkResend?.attempts).toBe(0);
    expect(checkResend?.lastErrorCode).toBeNull();
    expect(checkResend?.nextRunAt).not.toBeNull();
  });

  it("gera planilha CSV de leads com cabeçalhos e formatação", async () => {
    const { lead, user, tenant } = await createTestWorld();

    const { filename, csv, count } = await buildRescueLeadsCsv({ search: user.name ?? "" });
    expect(count).toBeGreaterThanOrEqual(1);
    expect(filename).toMatch(/^leads-resgate-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv).toContain("ID;Nome;Telefone;E-mail;Empresa;Status;");
    expect(csv).toContain(lead.id);
    expect(csv).toContain(tenant.name);
  });
});
