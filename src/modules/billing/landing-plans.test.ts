import { beforeEach, describe, expect, it, vi } from "vitest";

const listActivePlans = vi.fn();
vi.mock("./service", () => ({ listActivePlans: () => listActivePlans() }));

import { getLandingPlans, resetLandingPlansCache } from "./landing-plans";

const row = (over: Record<string, unknown>) => ({ id: "1", name: "A", priceCents: 5990, maxProfessionals: 3, maxWhatsappNumbers: 1, ...over });

describe("getLandingPlans", () => {
  beforeEach(() => {
    resetLandingPlansCache();
    listActivePlans.mockReset();
  });

  it("formata preço e limites a partir do banco", async () => {
    listActivePlans.mockResolvedValue([row({}), row({ id: "2", name: "B", maxProfessionals: null, maxWhatsappNumbers: 3 })]);
    const plans = await getLandingPlans(0);
    expect(plans?.[0].priceLabel.replace(/\s/g, " ")).toBe("R$ 59,90");
    expect(plans?.[0].professionalsLabel).toBe("Até 3 profissionais");
    expect(plans?.[0].whatsappLabel).toBe("1 número de WhatsApp");
    expect(plans?.[1].professionalsLabel).toBe("Profissionais ilimitados");
    expect(plans?.[1].whatsappLabel).toBe("3 números de WhatsApp");
  });

  it("devolve null se o banco falhar e tenta de novo após 10 s", async () => {
    listActivePlans.mockRejectedValueOnce(new Error("db"));
    expect(await getLandingPlans(0)).toBeNull();
    expect(await getLandingPlans(5_000)).toBeNull();
    expect(listActivePlans).toHaveBeenCalledTimes(1);
    listActivePlans.mockResolvedValue([row({})]);
    expect(await getLandingPlans(11_000)).toHaveLength(1);
  });

  it("usa cache por 60 s", async () => {
    listActivePlans.mockResolvedValue([row({})]);
    await getLandingPlans(0);
    await getLandingPlans(30_000);
    expect(listActivePlans).toHaveBeenCalledTimes(1);
    await getLandingPlans(61_000);
    expect(listActivePlans).toHaveBeenCalledTimes(2);
  });
});
