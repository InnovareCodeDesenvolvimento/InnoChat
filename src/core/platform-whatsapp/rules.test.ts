import { describe, expect, it } from "vitest";
import {
  buildPlatformInstanceName,
  formatPhoneDisplay,
  hashWebhookToken,
  isOptOutText,
  isQrAbandoned,
  maskPhone,
  NORMAL_ROUND_CAP,
  phoneDigitVariants,
  roundCapFor,
  WARMUP_ROUND_CAP,
  withNewNumberNotice,
} from "./rules";

describe("rules do WhatsApp da plataforma", () => {
  it("mascara e formata o telefone", () => {
    expect(maskPhone("558499998888")).toBe("+55 84 ****-8888");
    expect(maskPhone("+55 (84) 99999-8888")).toBe("+55 84 9****-8888");
    expect(maskPhone(null)).toBeNull();
    expect(formatPhoneDisplay("558499998888")).toBe("+55 84 9999-8888");
    expect(formatPhoneDisplay("5584999998888")).toBe("+55 84 99999-8888");
  });

  it("variantes de dígitos cobrem com e sem o 9º dígito", () => {
    expect(phoneDigitVariants("5584999998888").sort()).toEqual(["558499998888", "5584999998888"]);
    expect(phoneDigitVariants("")).toEqual([]);
  });

  it("teto menor nos 3 primeiros dias, normal depois", () => {
    const activated = new Date("2026-10-01T12:00:00Z");
    expect(roundCapFor(activated, new Date("2026-10-03T11:59:00Z"))).toBe(WARMUP_ROUND_CAP);
    expect(roundCapFor(activated, new Date("2026-10-04T12:01:00Z"))).toBe(NORMAL_ROUND_CAP);
  });

  it("QR abandonado depois de 30 minutos", () => {
    const created = new Date("2026-10-01T12:00:00Z");
    expect(isQrAbandoned(created, new Date("2026-10-01T12:29:00Z"))).toBe(false);
    expect(isQrAbandoned(created, new Date("2026-10-01T12:31:00Z"))).toBe(true);
  });

  it("reconhece SAIR com caixa, acento e pontuação soltos, mas não frases", () => {
    for (const text of ["SAIR", " sair ", "Sair!", "parar", "STOP"]) expect(isOptOutText(text)).toBe(true);
    for (const text of ["quero sair do plano", "oi", "", "sair agora e cancelar tudo"]) expect(isOptOutText(text)).toBe(false);
  });

  it("hash do token é estável e não devolve o token", () => {
    const hash = hashWebhookToken("abc");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashWebhookToken("abc"));
    expect(hash).not.toContain("abc");
  });

  it("nome de instância e aviso de novo número", () => {
    expect(buildPlatformInstanceName("AB12cd34")).toBe("innochat-plataforma-ab12cd34");
    expect(withNewNumberNotice("Sua fatura vence amanhã.")).toBe(
      "Este é o novo número de avisos do InnoChat. O anterior não envia mais mensagens.\n\nSua fatura vence amanhã.",
    );
  });
});

describe("autoreplyText", () => {
  it("indica o WhatsApp comercial cadastrado no Admin, ou o painel se não houver", async () => {
    const { autoreplyText } = await import("./rules");
    expect(autoreplyText("(84) 3113-2584")).toContain("Para falar com a gente, chame no (84) 3113-2584.");
    expect(autoreplyText(null)).toContain("pelo painel");
    expect(autoreplyText("(84) 3113-2584")).toContain("responda SAIR");
  });
});
