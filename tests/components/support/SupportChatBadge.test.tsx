import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SupportChatBadge } from "@/components/support/SupportChatBadge";

describe("SupportChatBadge", () => {
  it("não renderiza nada quando isSupportImpersonation é false ou indefinido", () => {
    const htmlFalse = renderToStaticMarkup(
      createElement(SupportChatBadge, { isSupportImpersonation: false, adminName: "Admin Teste" })
    );
    expect(htmlFalse).toBe("");

    const htmlUndefined = renderToStaticMarkup(
      createElement(SupportChatBadge, {})
    );
    expect(htmlUndefined).toBe("");
  });

  it("renderiza o selo com role status e nome do admin quando isSupportImpersonation é true", () => {
    const html = renderToStaticMarkup(
      createElement(SupportChatBadge, {
        isSupportImpersonation: true,
        adminName: "Paula Administradora",
      })
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="support-chat-badge"');
    expect(html).toContain("Enviando como suporte InnoChat");
    expect(html).toContain("Paula Administradora");
  });

  it("usa fallback 'Suporte' quando adminName não for informado ou estiver vazio", () => {
    const html = renderToStaticMarkup(
      createElement(SupportChatBadge, {
        isSupportImpersonation: true,
        adminName: "",
      })
    );

    expect(html).toContain("Enviando como suporte InnoChat");
    expect(html).toContain("Suporte");
  });
});
