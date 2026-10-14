import { describe, expect, it } from "vitest";
import {
  humanizeSince,
  RESCUE_MSG_1_TEMPLATE,
  RESCUE_MSG_2_TEMPLATE,
  RESCUE_OPT_OUT_CONFIRMATION,
} from "@/modules/rescue/messages";

describe("rescue/messages", () => {
  it("humanizeSince formata corretamente horas e dias", () => {
    const base = new Date("2026-10-14T12:00:00Z");

    const justNow = new Date("2026-10-14T11:30:00Z");
    expect(humanizeSince(justNow, base)).toBe("há pouco");

    const fewHours = new Date("2026-10-14T07:00:00Z");
    expect(humanizeSince(fewHours, base)).toBe("há 5 horas");

    const yesterday = new Date("2026-10-13T10:00:00Z");
    expect(humanizeSince(yesterday, base)).toBe("ontem");

    const threeDays = new Date("2026-10-11T12:00:00Z");
    expect(humanizeSince(threeDays, base)).toBe("há 3 dias");
  });

  it("RESCUE_MSG_1_TEMPLATE contém o nome, o tempo humanizado e o comando SAIR", () => {
    const text = RESCUE_MSG_1_TEMPLATE({ nome: "Carlos", faltou: "ontem" });
    expect(text).toContain("Oi, Carlos!");
    expect(text).toContain("ontem");
    expect(text).toContain("SAIR");
    expect(text).not.toContain("—"); // sem travessão na mensagem 1
  });

  it("RESCUE_MSG_2_TEMPLATE contém o nome e a opção de SAIR", () => {
    const text = RESCUE_MSG_2_TEMPLATE({ nome: "Mariana" });
    expect(text).toContain("Oi, Mariana!");
    expect(text).toContain("SAIR");
    expect(text).toContain("SIM");
  });

  it("RESCUE_OPT_OUT_CONFIRMATION confirma o opt-out educadamente", () => {
    expect(RESCUE_OPT_OUT_CONFIRMATION).toBe("Tudo certo, não mando mais. Obrigado!");
  });
});
