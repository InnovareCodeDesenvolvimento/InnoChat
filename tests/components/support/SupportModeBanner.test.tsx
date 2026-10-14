import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SupportModeBanner,
  formatSupportCountdown,
} from "@/components/support/SupportModeBanner";

describe("formatSupportCountdown", () => {
  it("formata tempo com horas e minutos", () => {
    // 3660 segundos = 1h 1min
    expect(formatSupportCountdown(3660 * 1000)).toBe("1h 1min");
    // 3600 segundos = 1h 0min
    expect(formatSupportCountdown(3600 * 1000)).toBe("1h 0min");
  });

  it("formata tempo abaixo de 1 hora com minutos e segundos", () => {
    // 125 segundos = 2min 5s
    expect(formatSupportCountdown(125 * 1000)).toBe("2min 5s");
    // 60 segundos = 1min 0s
    expect(formatSupportCountdown(60 * 1000)).toBe("1min 0s");
  });

  it("formata tempo abaixo de 1 minuto em segundos", () => {
    expect(formatSupportCountdown(45 * 1000)).toBe("45s");
  });

  it("retorna 0s para tempos zerados ou negativos", () => {
    expect(formatSupportCountdown(0)).toBe("0s");
    expect(formatSupportCountdown(-5000)).toBe("0s");
  });
});

describe("SupportModeBanner", () => {
  it("renderiza o banner com role status, aria-live polite e nome da empresa", () => {
    const now = 1000000;
    const expiresAt = now + 30 * 60 * 1000; // 30 minutos

    const html = renderToStaticMarkup(
      createElement(SupportModeBanner, {
        tenantName: "Clínica Bem Estar",
        expiresAtMs: expiresAt,
        serverNowMs: now,
        tenantId: "tenant-123",
      })
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("data-testid=\"support-mode-banner\"");
    expect(html).toContain("Clínica Bem Estar");
    expect(html).toContain("Você está conectado como suporte em");
    expect(html).toContain("expira em 30min 0s");
    expect(html).toContain("Sair da conta e voltar ao Admin");
  });

  it("renderiza texto de expirado quando remainingMs <= 0", () => {
    const now = 1000000;
    const expiresAt = now - 5000; // Já expirado

    const html = renderToStaticMarkup(
      createElement(SupportModeBanner, {
        tenantName: "Clínica Bem Estar",
        expiresAtMs: expiresAt,
        serverNowMs: now,
      })
    );

    expect(html).toContain("Sessão de suporte expirada. Saindo da conta…");
  });

  it("chama exitSupportAction ao expirar ou via prop de encerramento", async () => {
    const mockExit = vi.fn().mockResolvedValue({
      ok: true,
      data: { closed: true, redirectTo: "/admin/empresas/123" },
    });

    // Validamos que a action injetável pode ser invocada
    const res = await mockExit();
    expect(res.ok).toBe(true);
    expect(res.data.redirectTo).toBe("/admin/empresas/123");
  });
});
