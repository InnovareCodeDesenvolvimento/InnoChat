import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RescueListClient } from "@/components/admin/rescue/rescue-list-client";
import type { RescueLeadListResult } from "@/modules/rescue/admin-actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const mockData: RescueLeadListResult = {
  items: [
    {
      id: "lead-1",
      userId: "user-1",
      userName: "Carlos Silva",
      userEmail: "carlos@example.com",
      tenantId: "tenant-1",
      tenantName: "Studio Carlos",
      tenantSlug: "studio-carlos",
      phoneE164: "558499998888",
      status: "PENDING",
      nextRunAt: new Date("2026-10-15T12:00:00Z"),
      step1ScheduledAt: new Date("2026-10-15T12:00:00Z"),
      step1SentAt: null,
      step2ScheduledAt: new Date("2026-10-18T12:00:00Z"),
      step2SentAt: null,
      respondedAt: null,
      convertedAt: null,
      optedOutAt: null,
      lastErrorCode: null,
      attempts: 0,
      createdAt: new Date("2026-10-14T12:00:00Z"),
      updatedAt: new Date("2026-10-14T12:00:00Z"),
    },
    {
      id: "lead-2",
      userId: "user-2",
      userName: "Mariana Santos",
      userEmail: "mariana@example.com",
      tenantId: "tenant-2",
      tenantName: "Clínica Mariana",
      tenantSlug: "clinica-mariana",
      phoneE164: "551198887777",
      status: "MESSAGE_1_SENT",
      nextRunAt: new Date("2026-10-17T15:00:00Z"),
      step1ScheduledAt: new Date("2026-10-14T15:00:00Z"),
      step1SentAt: new Date("2026-10-14T15:05:00Z"),
      step2ScheduledAt: new Date("2026-10-17T15:00:00Z"),
      step2SentAt: null,
      respondedAt: null,
      convertedAt: null,
      optedOutAt: null,
      lastErrorCode: null,
      attempts: 0,
      createdAt: new Date("2026-10-13T15:00:00Z"),
      updatedAt: new Date("2026-10-14T15:05:00Z"),
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
  totalPages: 1,
  isRescueEnabled: true,
};

describe("RescueListClient (Component Test)", () => {
  it("renderiza lista com dados dos leads, badges de status e telefone formatado", () => {
    const html = renderToStaticMarkup(
      createElement(RescueListClient, {
        data: mockData,
        filters: { page: 1, pageSize: 25 },
      })
    );

    expect(html).toContain("Carlos Silva");
    expect(html).toContain("carlos@example.com");
    expect(html).toContain("Studio Carlos");
    expect(html).toContain("+55 (84) 9999-8888");
    expect(html).toContain("Aguardando 1º envio");

    expect(html).toContain("Mariana Santos");
    expect(html).toContain("mariana@example.com");
    expect(html).toContain("Clínica Mariana");
    expect(html).toContain("+55 (11) 9888-7777");
    expect(html).toContain("Passo 1 enviado");

    expect(html).toContain("Mostrando 1–2 de 2 leads");
    expect(html).toContain("/admin/resgate/lead-1");
    expect(html).toContain("/admin/resgate/lead-2");
  });

  it("exibe alerta de kill switch pausado quando isRescueEnabled for false", () => {
    const html = renderToStaticMarkup(
      createElement(RescueListClient, {
        data: { ...mockData, isRescueEnabled: false },
        filters: { page: 1, pageSize: 25 },
      })
    );

    expect(html).toContain("A régua de resgate está pausada globalmente (Kill switch acionado).");
    expect(html).toContain("Reativar régua");
  });

  it("exibe estado vazio amigável quando a lista não possui leads sem filtros", () => {
    const html = renderToStaticMarkup(
      createElement(RescueListClient, {
        data: { ...mockData, items: [], total: 0, totalPages: 1 },
        filters: { page: 1, pageSize: 25 },
      })
    );

    expect(html).toContain("Nenhum lead em resgate no momento");
    expect(html).toContain("Quem se cadastrar pelo Meta Ads aparece aqui em 24h");
  });

  it("exibe mensagem clara quando filtros ativos não retornam nenhum lead", () => {
    const html = renderToStaticMarkup(
      createElement(RescueListClient, {
        data: { ...mockData, items: [], total: 0, totalPages: 1 },
        filters: { search: "termo-inexistente", page: 1, pageSize: 25 },
      })
    );

    expect(html).toContain("Nenhum lead encontrado");
    expect(html).toContain("Nenhum cadastro corresponde aos filtros aplicados.");
  });
});
