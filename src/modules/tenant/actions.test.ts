import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";

/**
 * `assertTenantCanWrite` na troca de tema (revisão de segurança 2026-09-28, achado BAIXA) —
 * mesma lacuna de `bot-text-actions.ts`.
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

const updateTenantThemeMock = vi.fn();
const getBotRulesMock = vi.fn();
const updateBotRulesMock = vi.fn();
vi.mock("./service", () => ({
  updateTenantTheme: updateTenantThemeMock,
  getBotRules: getBotRulesMock,
  updateBotRules: updateBotRulesMock,
}));

const { updateTenantThemeAction, updateBotRulesAction, getBotRulesAction } = await import("./actions");

afterEach(() => {
  vi.clearAllMocks();
});

describe("updateTenantThemeAction — bloqueio de escrita", () => {
  it("tenant SUSPENDED devolve TENANT_SUSPENDED, sem chamar updateTenantTheme", async () => {
    requireTenantMemberMock.mockResolvedValue({ tenant: TENANT, user: { id: "u1" } });
    assertTenantCanWriteMock.mockRejectedValue(new DomainError("TENANT_SUSPENDED", "Assinatura suspensa."));

    const result = await updateTenantThemeAction("studio-demo", { theme: "AMBAR_ESTUDIO" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TENANT_SUSPENDED");
    expect(updateTenantThemeMock).not.toHaveBeenCalled();
  });

  it("tenant ativo passa e chama updateTenantTheme normalmente", async () => {
    requireTenantMemberMock.mockResolvedValue({ tenant: TENANT, user: { id: "u1" } });
    assertTenantCanWriteMock.mockResolvedValue(undefined);
    updateTenantThemeMock.mockResolvedValue({ theme: "AMBAR_ESTUDIO" });

    const result = await updateTenantThemeAction("studio-demo", { theme: "AMBAR_ESTUDIO" });

    expect(result.ok).toBe(true);
    expect(updateTenantThemeMock).toHaveBeenCalledWith(TENANT.id, "AMBAR_ESTUDIO");
  });
});

describe("updateBotRulesAction / getBotRulesAction", () => {
  const valid = { maxFutureAppointmentsPerContact: 3, slotGranularityMin: 30, handoffResumeMinutes: 120 };

  function asOwner() {
    requireTenantMemberMock.mockResolvedValue({ tenant: TENANT, user: { id: "u1" } });
    assertTenantCanWriteMock.mockResolvedValue(undefined);
  }

  it("exige OWNER (STAFF é barrado pelo guard) e não grava", async () => {
    requireTenantMemberMock.mockRejectedValue(new DomainError("FORBIDDEN", "Sem permissão."));
    const result = await updateBotRulesAction("studio-demo", valid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(requireTenantMemberMock).toHaveBeenCalledWith("studio-demo", ["OWNER"]);
    expect(updateBotRulesMock).not.toHaveBeenCalled();
  });

  it.each([
    ["grade 45", { ...valid, slotGranularityMin: 45 }, "slotGranularityMin"],
    ["retomada 0", { ...valid, handoffResumeMinutes: 0 }, "handoffResumeMinutes"],
    ["retomada 1500", { ...valid, handoffResumeMinutes: 1500 }, "handoffResumeMinutes"],
    ["retomada 100 (não múltiplo de 15)", { ...valid, handoffResumeMinutes: 100 }, "handoffResumeMinutes"],
    ["limite 21", { ...valid, maxFutureAppointmentsPerContact: 21 }, "maxFutureAppointmentsPerContact"],
    ["limite -1", { ...valid, maxFutureAppointmentsPerContact: -1 }, "maxFutureAppointmentsPerContact"],
    ["limite fracionado", { ...valid, maxFutureAppointmentsPerContact: 1.5 }, "maxFutureAppointmentsPerContact"],
  ])("recusa %s com INVALID_PAYLOAD { field }", async (_name, input, field) => {
    asOwner();
    const result = await updateBotRulesAction("studio-demo", input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PAYLOAD");
      expect(result.error.details).toEqual({ field });
    }
    expect(updateBotRulesMock).not.toHaveBeenCalled();
  });

  it("aceita limites de borda (0, 20, 15, 30, 1440) e grava", async () => {
    asOwner();
    updateBotRulesMock.mockResolvedValue({ ...valid, humanPauseMin: 720 });
    for (const input of [
      { maxFutureAppointmentsPerContact: 0, slotGranularityMin: 15, handoffResumeMinutes: 30 },
      { maxFutureAppointmentsPerContact: 20, slotGranularityMin: 30, handoffResumeMinutes: 1440 },
    ]) {
      const result = await updateBotRulesAction("studio-demo", input);
      expect(result.ok).toBe(true);
      expect(updateBotRulesMock).toHaveBeenLastCalledWith(TENANT.id, input);
    }
  });

  it("tenant suspenso não grava", async () => {
    asOwner();
    assertTenantCanWriteMock.mockRejectedValue(new DomainError("TENANT_SUSPENDED", "Assinatura suspensa."));
    const result = await updateBotRulesAction("studio-demo", valid);
    expect(result.ok).toBe(false);
    expect(updateBotRulesMock).not.toHaveBeenCalled();
  });

  it("get devolve as regras do tenant da sessão", async () => {
    asOwner();
    getBotRulesMock.mockResolvedValue({ ...valid, humanPauseMin: 720 });
    const result = await getBotRulesAction("studio-demo");
    expect(result).toEqual({ ok: true, data: { ...valid, humanPauseMin: 720 } });
    expect(getBotRulesMock).toHaveBeenCalledWith(TENANT.id);
  });

  it("get é liberado a qualquer membro (STAFF lê): guard sem restrição de papel", async () => {
    requireTenantMemberMock.mockResolvedValue({ tenant: TENANT, user: { id: "staff-1" }, membership: { role: "STAFF" } });
    getBotRulesMock.mockResolvedValue({ ...valid, humanPauseMin: 720 });
    const result = await getBotRulesAction("studio-demo");
    expect(result.ok).toBe(true);
    expect(requireTenantMemberMock).toHaveBeenCalledWith("studio-demo");
  });
});
