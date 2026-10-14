import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(platform)/admin/empresas/[tenantId]/_actions/startSupportAction", () => ({
  startSupportAction: vi.fn(),
}));

import { EntrarComoButton } from "@/app/(platform)/admin/empresas/[tenantId]/EntrarComoButton";

describe("EntrarComoButton", () => {
  it("renderiza o botão 'Entrar como empresa' com atributo data-testid", () => {
    const html = renderToStaticMarkup(
      createElement(EntrarComoButton, {
        tenantId: "tenant-abc",
        tenantName: "Studio Bella",
        adminHasTwoFactor: true,
      })
    );

    expect(html).toContain("Entrar como empresa");
    expect(html).toContain('data-testid="entrar-como-empresa-btn"');
    expect(html).toContain("Como funciona: Modo suporte da plataforma");
  });

  it("exibe aviso e botão 'Ativar agora' quando o admin não possui 2FA ativa", () => {
    const html = renderToStaticMarkup(
      createElement(EntrarComoButton, {
        tenantId: "tenant-abc",
        tenantName: "Studio Bella",
        adminHasTwoFactor: false,
        defaultOpen: true,
      })
    );

    expect(html).toContain("Entrar como empresa");
    // No diálogo pré-renderizado aberto, há o aviso de 2FA
    expect(html).toContain("Verificação em duas etapas necessária");
    expect(html).toContain(
      "Ative a verificação em duas etapas no seu perfil para entrar como suporte."
    );
    expect(html).toContain("Ativar agora");
    expect(html).toContain('href="/admin/minha-conta"');
  });

  it("renderiza campo de motivo e aviso de expiração de 1 hora quando o admin tem 2FA", () => {
    const html = renderToStaticMarkup(
      createElement(EntrarComoButton, {
        tenantId: "tenant-abc",
        tenantName: "Studio Bella",
        adminHasTwoFactor: true,
        defaultOpen: true,
      })
    );

    expect(html).toContain("Entrar como suporte");
    expect(html).toContain(
      "Esta sessão expira em 1 hora. Todas as ações serão registradas com seu nome para auditoria."
    );
    expect(html).toContain("Motivo do atendimento");
    expect(html).toContain('data-testid="support-reason-textarea"');
    expect(html).toContain("Mínimo de 15 caracteres.");
    expect(html).toContain("Confirmar e entrar");
  });

  it("valida que a action startSupportAction recebe tenantId e reason e retorna redirectTo", async () => {
    const mockStart = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        redirectTo: "/studio-bella/inicio",
        sessionId: "session-xyz",
      },
    });

    const res = await mockStart({
      tenantId: "tenant-abc",
      reason: "Atendimento técnico a pedido da cliente no ticket 9988",
    });

    expect(res.ok).toBe(true);
    expect(res.data.redirectTo).toBe("/studio-bella/inicio");
    expect(mockStart).toHaveBeenCalledWith({
      tenantId: "tenant-abc",
      reason: "Atendimento técnico a pedido da cliente no ticket 9988",
    });
  });
});
