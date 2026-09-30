import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";

/**
 * `assertTenantCanWrite` nas mutações de `BotText` (revisão de segurança 2026-09-28, achado
 * BAIXA) — faltava, então uma empresa `SUSPENDED`/`CANCELED` conseguia editar textos do bot
 * mesmo com o painel supostamente "só leitura".
 */

const TENANT = { id: "tenant-1", slug: "studio-demo", name: "Studio", timezone: "America/Sao_Paulo" };

const requireTenantMemberMock = vi.fn();
vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: requireTenantMemberMock,
}));

const assertTenantCanWriteMock = vi.fn();
vi.mock("@/modules/billing/service", () => ({
  assertTenantCanWrite: assertTenantCanWriteMock,
}));

const upsertBotTextMock = vi.fn();
const resetBotTextMock = vi.fn();
vi.mock("./service", () => ({
  getPublishedFlowVersion: vi.fn().mockResolvedValue(1),
  listBotTexts: vi.fn(),
  previewBotText: vi.fn(),
  upsertBotText: upsertBotTextMock,
  resetBotText: resetBotTextMock,
}));

const { upsertBotTextAction, resetBotTextAction } = await import("./bot-text-actions");

afterEach(() => {
  vi.clearAllMocks();
});

describe("upsertBotTextAction / resetBotTextAction — bloqueio de escrita", () => {
  it("upsert: tenant SUSPENDED devolve erro TENANT_SUSPENDED, sem chamar upsertBotText", async () => {
    requireTenantMemberMock.mockResolvedValue({ tenant: TENANT, user: { id: "u1" } });
    assertTenantCanWriteMock.mockRejectedValue(new DomainError("TENANT_SUSPENDED", "Assinatura suspensa."));

    const result = await upsertBotTextAction("studio-demo", { key: "GREETING", text: "Olá!" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TENANT_SUSPENDED");
    expect(upsertBotTextMock).not.toHaveBeenCalled();
  });

  it("reset: tenant CANCELED devolve erro TENANT_SUSPENDED, sem chamar resetBotText", async () => {
    requireTenantMemberMock.mockResolvedValue({ tenant: TENANT, user: { id: "u1" } });
    assertTenantCanWriteMock.mockRejectedValue(new DomainError("TENANT_SUSPENDED", "Assinatura suspensa."));

    const result = await resetBotTextAction("studio-demo", "GREETING");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TENANT_SUSPENDED");
    expect(resetBotTextMock).not.toHaveBeenCalled();
  });

  it("upsert: tenant ativo passa e chama upsertBotText normalmente", async () => {
    requireTenantMemberMock.mockResolvedValue({ tenant: TENANT, user: { id: "u1" } });
    assertTenantCanWriteMock.mockResolvedValue(undefined);
    upsertBotTextMock.mockResolvedValue({ key: "GREETING", text: "Olá!" });

    const result = await upsertBotTextAction("studio-demo", { key: "GREETING", text: "Olá!" });

    expect(result.ok).toBe(true);
    expect(upsertBotTextMock).toHaveBeenCalledWith(TENANT.id, "GREETING", "Olá!", 1);
  });
});
