import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SupportAccessCard } from "@/components/billing/support-access-card";
import type { SupportSessionItem } from "@/modules/billing/support-actions-types";
import { HelpVisibilityProvider } from "@/components/help/help-visibility";

function withProviders(children: React.ReactNode) {
  return <HelpVisibilityProvider>{children}</HelpVisibilityProvider>;
}

describe("SupportAccessCard", () => {
  it("exibe mensagem amigável quando não há acessos registrados", () => {
    const html = renderToStaticMarkup(
      withProviders(<SupportAccessCard items={[]} />)
    );

    expect(html).toContain("data-testid=\"support-access-card\"");
    expect(html).toContain("Acessos do Suporte");
    expect(html).toContain("Nenhum acesso de suporte registrado para esta empresa");
  });

  it("exibe lista de acessos com admin, status, motivo e datas formatadas", () => {
    const items: SupportSessionItem[] = [
      {
        id: "sess-1",
        adminName: "Carlos Admin",
        adminEmail: "carlos@innochat.com.br",
        reason: "Auxílio na configuração de faturas do cliente",
        startedAt: "2026-10-14T10:00:00.000Z",
        expiresAt: "2026-10-14T11:00:00.000Z",
        closedAt: null,
        closeReason: null,
        status: "ACTIVE",
      },
      {
        id: "sess-2",
        adminName: "Ana Suporte",
        adminEmail: "ana@innochat.com.br",
        reason: "Verificação de erro no Pix",
        startedAt: "2026-10-13T14:00:00.000Z",
        expiresAt: "2026-10-13T15:00:00.000Z",
        closedAt: "2026-10-13T14:45:00.000Z",
        closeReason: "MANUAL",
        status: "CLOSED",
      },
    ];

    const html = renderToStaticMarkup(
      withProviders(<SupportAccessCard items={items} />)
    );

    expect(html).toContain("Carlos Admin");
    expect(html).toContain("carlos@innochat.com.br");
    expect(html).toContain("Em andamento");
    expect(html).toContain("Auxílio na configuração de faturas do cliente");

    expect(html).toContain("Ana Suporte");
    expect(html).toContain("ana@innochat.com.br");
    expect(html).toContain("Encerrada");
    expect(html).toContain("Verificação de erro no Pix");
  });

  it("inclui paginação numerada quando há mais de 10 itens", () => {
    const items: SupportSessionItem[] = Array.from({ length: 15 }, (_, i) => ({
      id: `sess-${i + 1}`,
      adminName: `Admin ${i + 1}`,
      adminEmail: `admin${i + 1}@innochat.com.br`,
      reason: `Manutenção de rotina ${i + 1} para suporte`,
      startedAt: "2026-10-14T10:00:00.000Z",
      expiresAt: "2026-10-14T11:00:00.000Z",
      closedAt: null,
      closeReason: null,
      status: "ACTIVE",
    }));

    const html = renderToStaticMarkup(
      withProviders(<SupportAccessCard items={items} />)
    );

    expect(html).toContain("Paginação dos acessos de suporte");
    expect(html).toContain("Mostrando");
    expect(html).toContain("de ");
    expect(html).toContain("15");
  });
});
