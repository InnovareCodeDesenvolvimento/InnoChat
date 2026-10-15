import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlatformWhatsappCard } from "@/components/admin/platform-whatsapp-card";
import type { PlatformWhatsappState } from "@/modules/platform/platform-whatsapp-actions-types";
import { ToastProvider } from "@/components/ui/toast";

// Mock do useRouter do Next.js
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
  }),
}));

vi.mock("@/modules/platform/platform-whatsapp-actions", () => ({
  cancelPlatformWhatsappConnectionAction: vi.fn(),
  disconnectPlatformWhatsappAction: vi.fn(),
  getPlatformWhatsappAction: vi.fn(),
  getPlatformWhatsappQrAction: vi.fn(),
  sendPlatformWhatsappTestAction: vi.fn(),
  setPlatformWhatsappEnabledAction: vi.fn(),
  startPlatformWhatsappConnectionAction: vi.fn(),
}));

vi.mock("@/modules/rescue/admin-actions", () => ({
  toggleRescueEnabledAction: vi.fn(),
}));

function withToast(children: React.ReactNode) {
  return createElement(ToastProvider, null, children);
}

describe("PlatformWhatsappCard com purpose RESCUE", () => {
  it("renderiza o card de WhatsApp de resgate com título, descrição e ícone corretos", () => {
    const initialState: PlatformWhatsappState = {
      enabled: true,
      active: null,
      pending: null,
      history: [],
    };

    const html = renderToStaticMarkup(
      withToast(
        createElement(PlatformWhatsappCard, {
          initialState,
          purpose: "RESCUE",
          title: "WhatsApp de resgate",
          description:
            "O número que envia mensagens automáticas de acolhimento a quem veio pelo Meta Ads e ainda não acessou o painel da empresa.",
          cardId: "whatsapp-resgate",
          helpKey: "admin.whatsappResgate",
          labelDefault: "Resgate",
          enabledSwitchLabel: "Mandar mensagens de resgate pelo WhatsApp",
          connectButtonLabel: "Conectar WhatsApp de resgate",
          disabledNotice:
            "Desligado: nenhuma mensagem de acolhimento é enviada aos novos cadastros.",
          emptyNotice:
            "Nenhum número conectado para o resgate. Os novos cadastros não recebem mensagens de acolhimento.",
        })
      )
    );

    expect(html).toContain('id="whatsapp-resgate"');
    expect(html).toContain("WhatsApp de resgate");
    expect(html).toContain(
      "O número que envia mensagens automáticas de acolhimento a quem veio pelo Meta Ads e ainda não acessou o painel da empresa."
    );
    expect(html).toContain("Ligado");
    expect(html).toContain("Conectar WhatsApp de resgate");
    expect(html).toContain(
      "Nenhum número conectado para o resgate. Os novos cadastros não recebem mensagens de acolhimento."
    );
  });

  it("exibe o emptyStateBox quando o switch está desligado e não há número conectado", () => {
    const initialState: PlatformWhatsappState = {
      enabled: false,
      active: null,
      pending: null,
      history: [],
    };

    const html = renderToStaticMarkup(
      withToast(
        createElement(PlatformWhatsappCard, {
          initialState,
          purpose: "RESCUE",
          title: "WhatsApp de resgate",
          cardId: "whatsapp-resgate",
          emptyStateBox: createElement(
            "div",
            { "data-testid": "rescue-empty-box" },
            "Ligue a chave geral de resgate nas Configurações de Marketing e conecte o chip aqui para começar."
          ),
        })
      )
    );

    expect(html).toContain("Desligado");
    expect(html).toContain('data-testid="rescue-empty-box"');
    expect(html).toContain(
      "Ligue a chave geral de resgate nas Configurações de Marketing e conecte o chip aqui para começar."
    );
    // Não mostra o aviso padrão quando o emptyStateBox customizado está presente
    expect(html).not.toContain("Desligado: os avisos de cobrança vão só por e-mail");
  });

  it("renderiza o número ativo formatado e as ações humanizadas quando há conexão ACTIVE", () => {
    const initialState: PlatformWhatsappState = {
      enabled: true,
      active: {
        id: "conn-rescue-1",
        label: "Chip Resgate 1",
        status: "CONNECTED",
        phoneDisplay: "(11) 98888-7777",
        activatedAt: "2026-10-14T10:00:00.000Z",
        disconnectedAt: null,
        inWarmup: false,
        roundCap: 30,
        diagnostics: {
          lastInboundAt: null,
          lastInboundFrom: null,
          lastAutoreplyAt: null,
          lastEventAt: null,
          notRepliedReason: null,
          webhookNote: null,
        },
      },
      pending: null,
      history: [],
    };

    const html = renderToStaticMarkup(
      withToast(
        createElement(PlatformWhatsappCard, {
          initialState,
          purpose: "RESCUE",
          title: "WhatsApp de resgate",
          cardId: "whatsapp-resgate",
          connectButtonLabel: "Conectar WhatsApp de resgate",
        })
      )
    );

    expect(html).toContain("(11) 98888-7777");
    expect(html).toContain("Chip Resgate 1");
    expect(html).toContain("Conectado");
    expect(html).toContain("Enviar teste");
    expect(html).toContain("Trocar de número");
    expect(html).toContain("Desconectar");
  });
});
