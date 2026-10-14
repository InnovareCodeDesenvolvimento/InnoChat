import { describe, it, expect, vi, beforeEach } from "vitest";
import { resendPaymentLinkAction } from "@/modules/billing/support-actions";
import * as billingService from "@/modules/billing/service";
import * as emailModule from "@/lib/email";

const mockPrisma = {
  tenant: {
    findUnique: vi.fn(),
  },
  platformSettings: {
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

describe("support-payment-link action (unit)", () => {
  const tenant = {
    id: "tenant-123",
    slug: "clinica-teste",
    name: "Clínica Teste",
    timezone: "America/Sao_Paulo",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.tenant.findUnique.mockResolvedValue(tenant);
    mockPrisma.platformSettings.findUnique.mockResolvedValue({
      publicBaseUrl: "https://app.innochat.com.br",
    });
  });

  it("recusa se a fatura não estiver em status OPEN", async () => {
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "supp", role: "OWNER" },
      user: { id: "admin-1" },
      isSupportImpersonation: true,
      supportSessionId: "session-abc",
    });

    vi.spyOn(billingService, "findOwnInvoiceOrThrow").mockResolvedValue({
      id: "inv-1",
      subscriptionId: "sub-1",
      amountCents: 9900,
      periodStart: new Date(),
      periodEnd: new Date(),
      dueAt: new Date(),
      status: "PAID",
      mpPaymentId: null,
      pixQrCode: null,
      pixCopyPaste: null,
      pixExpiresAt: null,
      paidAt: null,
      mpEnvironment: null,
      mpLastCheckedAt: null,
      dueReminderEmailSentAt: null,
      dueTodayEmailSentAt: null,
      isTrialConversion: false,
      paidWhileVoidAt: null,
      paidByPaymentId: null,
      duplicatePaymentAt: null,
      discountCents: 0,
      couponCode: null,
      cycle: "MONTHLY",
      createdAt: new Date(),
      updatedAt: new Date(),
      subscription: { tenantId: tenant.id } as never,
    });

    const res = await resendPaymentLinkAction(tenant.slug, {
      invoiceId: "inv-1",
      reason: "Reenvio de link solicitado pelo cliente no chamado",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_STATE");
    }
  });

  it("regenera Pix se expirado e dispara e-mail com link de cobrança e auditoria", async () => {
    mockGuard.requireTenantMember.mockResolvedValue({
      tenant,
      membership: { id: "supp", role: "OWNER" },
      user: { id: "admin-1" },
      isSupportImpersonation: true,
      supportSessionId: "session-abc",
    });

    vi.spyOn(billingService, "findOwnInvoiceOrThrow").mockResolvedValue({
      id: "inv-1",
      subscriptionId: "sub-1",
      amountCents: 9900,
      periodStart: new Date(),
      periodEnd: new Date(),
      dueAt: new Date(),
      status: "OPEN",
      mpPaymentId: null,
      pixQrCode: null,
      pixCopyPaste: null,
      pixExpiresAt: null,
      paidAt: null,
      mpEnvironment: null,
      mpLastCheckedAt: null,
      dueReminderEmailSentAt: null,
      dueTodayEmailSentAt: null,
      isTrialConversion: false,
      paidWhileVoidAt: null,
      paidByPaymentId: null,
      duplicatePaymentAt: null,
      discountCents: 0,
      couponCode: null,
      cycle: "MONTHLY",
      createdAt: new Date(),
      updatedAt: new Date(),
      subscription: { tenantId: tenant.id } as never,
    });

    vi.spyOn(billingService, "findBillingRecipientEmail").mockResolvedValue("financeiro@clinica.com");
    const regenSpy = vi.spyOn(billingService, "regeneratePixForInvoice").mockResolvedValue({
      id: "inv-1",
      subscriptionId: "sub-1",
      amountCents: 9900,
      periodStart: new Date(),
      periodEnd: new Date(),
      dueAt: new Date(),
      status: "OPEN",
      mpPaymentId: "pay-1",
      pixQrCode: "qrcode-base64",
      pixCopyPaste: "00020126580014br.gov.bcb.pix...",
      pixExpiresAt: new Date(Date.now() + 86400_000),
      paidAt: null,
      mpEnvironment: null,
      mpLastCheckedAt: null,
      dueReminderEmailSentAt: null,
      dueTodayEmailSentAt: null,
      isTrialConversion: false,
      paidWhileVoidAt: null,
      paidByPaymentId: null,
      duplicatePaymentAt: null,
      discountCents: 0,
      couponCode: null,
      cycle: "MONTHLY",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const sendMailSpy = vi.spyOn(emailModule, "sendMail").mockResolvedValue({ sent: true, rejectedCount: 0, accepted: ["contato@bela.com"], rejected: [] });
    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await resendPaymentLinkAction(tenant.slug, {
      invoiceId: "inv-1",
      reason: "Cliente não recebeu o e-mail anterior com o Pix",
    });

    if (!res.ok) {
      console.error("DEBUG RES ERROR:", res.error);
    }

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.invoiceId).toBe("inv-1");
      expect(res.data.recipientEmail).toBe("financeiro@clinica.com");
      expect(res.data.pixCopyPaste).toBe("00020126580014br.gov.bcb.pix...");
    }

    expect(regenSpy).toHaveBeenCalledWith("inv-1", "financeiro@clinica.com");
    expect(sendMailSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "financeiro@clinica.com",
        subject: expect.stringContaining("Fatura do InnoChat"),
      })
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "billing.payment_link_resent",
          actorRole: "PLATFORM_ADMIN",
          actorUserId: "admin-1",
          supportSessionId: "session-abc",
          tenantId: tenant.id,
        }),
      })
    );
  });
});
