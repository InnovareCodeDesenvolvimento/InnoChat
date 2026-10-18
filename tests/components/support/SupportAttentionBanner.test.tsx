import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SupportAttentionBanner } from "@/components/support/SupportAttentionBanner";

describe("SupportAttentionBanner", () => {
  it("não renderiza nada quando isSupportImpersonation é false ou indefinido", () => {
    const htmlFalse = renderToStaticMarkup(
      createElement(SupportAttentionBanner, { isSupportImpersonation: false })
    );
    expect(htmlFalse).toBe("");

    const htmlUndefined = renderToStaticMarkup(
      createElement(SupportAttentionBanner, {})
    );
    expect(htmlUndefined).toBe("");
  });

  it("renderiza o banner de atenção com role status quando isSupportImpersonation é true", () => {
    const html = renderToStaticMarkup(
      createElement(SupportAttentionBanner, {
        isSupportImpersonation: true,
      })
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="support-attention-banner"');
    expect(html).toContain("Você está respondendo como suporte InnoChat.");
    expect(html).toContain("O cliente vê um selo &quot;Suporte&quot; na mensagem enviada.");
  });
});
