import { describe, expect, it, vi } from "vitest";

// Mock de next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  usePathname: () => "/clinica-bela/assinatura",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock das actions de suporte de billing
vi.mock("@/modules/billing/support-actions", () => ({
  extendTrialAction: vi.fn(),
  applySupportCouponAction: vi.fn(),
  resendPaymentLinkAction: vi.fn(),
  listSupportSessionsAction: vi.fn(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/ui/toast";
import { HelpVisibilityProvider } from "@/components/help/help-visibility";
import { SupportActionsCard } from "@/components/billing/support-actions-card";

function withProviders(children: React.ReactNode) {
  return (
    <ToastProvider>
      <HelpVisibilityProvider>
        {children}
      </HelpVisibilityProvider>
    </ToastProvider>
  );
}

describe("SupportActionsCard", () => {
  it("não renderiza nada se isSupportImpersonation for falso ou indefinido", () => {
    const htmlFalse = renderToStaticMarkup(
      withProviders(
        <SupportActionsCard
          tenantSlug="clinica-bela"
          isSupportImpersonation={false}
        />
      )
    );
    const htmlUndef = renderToStaticMarkup(
      withProviders(
        <SupportActionsCard
          tenantSlug="clinica-bela"
        />
      )
    );

    expect(htmlFalse).not.toContain("support-actions-card");
    expect(htmlUndef).not.toContain("support-actions-card");
  });

  it("renderiza card com os 3 botões de ação quando isSupportImpersonation for true", () => {
    const invoices = [
      { id: "inv-1", amountCents: 5900, dueAt: "2026-11-01T00:00:00.000Z", status: "OPEN" },
    ];

    const html = renderToStaticMarkup(
      withProviders(
        <SupportActionsCard
          tenantSlug="clinica-bela"
          isSupportImpersonation={true}
          isTrialing={true}
          invoices={invoices}
          container={null}
        />
      )
    );

    expect(html).toContain("data-testid=\"support-actions-card\"");
    expect(html).toContain("Ações de Suporte (Cobrança)");
    expect(html).toContain("Estender período de teste");
    expect(html).toContain("Aplicar cupom");
    expect(html).toContain("Reenviar link de pagamento");
  });

  it("exibe aviso quando a empresa não estiver com status trialing", () => {
    const html = renderToStaticMarkup(
      withProviders(
        <SupportActionsCard
          tenantSlug="clinica-bela"
          isSupportImpersonation={true}
          isTrialing={false}
          container={null}
        />
      )
    );

    expect(html).toContain("Ações de Suporte (Cobrança)");
  });
});
