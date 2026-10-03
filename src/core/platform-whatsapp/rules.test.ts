import { describe, expect, it } from "vitest";
import {
  buildPlatformInstanceName,
  decideAutoreply,
  describeSkipReason,
  formatPhoneDisplay,
  hashPhoneForDedup,
  hashWebhookToken,
  isConfirmText,
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
    expect(autoreplyText("(84) 3113-2584")).toContain("Para falar com a gente, chame no *(84) 3113-2584*.");
    expect(autoreplyText(null)).toContain("pelo painel");
    expect(autoreplyText("(84) 3113-2584")).toContain("Responda *SAIR*");
  });

  it("texto novo (2026-10-03): formatação do WhatsApp, quebras de linha e nenhum travessão", async () => {
    const { autoreplyText, OPT_OUT_CONFIRMATION, CONFIRM_REPLY, optOutNotFoundText } = await import("./rules");
    expect(autoreplyText("(84) 3113-2584")).toBe(
      "Oi! 👋 Aqui é o *InnoChat*.\n\nEste número só envia *avisos de cobrança* e não lê respostas.\n\n💬 Para falar com a gente, chame no *(84) 3113-2584*.\n\n🔕 Não quer mais receber os avisos por aqui? Responda *SAIR*.\n\n_Os avisos continuam chegando por e-mail e no seu painel._",
    );
    for (const text of [autoreplyText("(84) 3113-2584"), autoreplyText(null), OPT_OUT_CONFIRMATION, CONFIRM_REPLY, optOutNotFoundText(null), optOutNotFoundText("(84) 3113-2584")]) {
      expect(text).not.toMatch(/[—–]/);
    }
    expect(OPT_OUT_CONFIRMATION).toContain("não vai mais receber");
    expect(CONFIRM_REPLY).toContain("número confirmado");
    expect(CONFIRM_REPLY).toContain("*SAIR*");
    expect(optOutNotFoundText("(84) 3113-2584")).toContain("*(84) 3113-2584*");
  });
});

describe("decideAutoreply (10 min entre respostas, teto de 6 por dia)", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);

  it("sem resposta recente: responde", () => {
    expect(decideAutoreply([], now, false)).toEqual({ allow: true });
  });

  it("dentro de 10 min não responde e informa há quantos minutos; passou de 10 min responde", () => {
    expect(decideAutoreply([ago(3)], now, false)).toEqual({ allow: false, reason: "RECENT", minutesAgo: 3 });
    expect(decideAutoreply([ago(9.9)], now, false)).toMatchObject({ allow: false, reason: "RECENT" });
    expect(decideAutoreply([ago(10)], now, false)).toEqual({ allow: true });
    expect(decideAutoreply([ago(11)], now, false)).toEqual({ allow: true });
  });

  it("a 7ª no dia não responde, mesmo espaçadas; respostas com mais de 24 h não contam", () => {
    const six = [ago(30), ago(60), ago(120), ago(240), ago(480), ago(960)];
    expect(decideAutoreply(six.slice(0, 5), now, false)).toEqual({ allow: true });
    expect(decideAutoreply(six, now, false)).toEqual({ allow: false, reason: "DAILY_CAP" });
    expect(decideAutoreply([...six.slice(0, 5), ago(25 * 60)], now, false)).toEqual({ allow: true });
  });

  it("SAIR/SIM (prioridade) ignoram o intervalo e o teto normal, mas têm um teto alto contra loop", () => {
    expect(decideAutoreply([ago(1)], now, true)).toEqual({ allow: true });
    expect(decideAutoreply(Array.from({ length: 6 }, (_, i) => ago(i + 1)), now, true)).toEqual({ allow: true });
    expect(decideAutoreply(Array.from({ length: 30 }, (_, i) => ago(i + 1)), now, true)).toEqual({ allow: false, reason: "DAILY_CAP" });
  });
});

describe("describeSkipReason", () => {
  it("diz o motivo em português", () => {
    expect(describeSkipReason("COMPANY_BOT")).toBe("não respondeu: o número é o WhatsApp de uma empresa cadastrada");
    expect(describeSkipReason("RECENT", 3)).toBe("não respondeu: já respondeu há 3 min");
    expect(describeSkipReason("DAILY_CAP")).toContain("6 vezes hoje");
    expect(describeSkipReason("OWN_NUMBER")).toContain("próprio WhatsApp de cobrança");
    expect(describeSkipReason(null)).toBeNull();
  });
});

describe("isConfirmText e hashPhoneForDedup", () => {
  it("reconhece o SIM com caixa, acento e pontuação soltos, e nada além disso", () => {
    for (const text of ["sim", " SIM! ", "Sim.", "confirmo", "Confirmo!"]) expect(isConfirmText(text)).toBe(true);
    for (const text of ["", "s", "confirmar", "simm", "sim, mas quero cancelar", "não", "sair"]) expect(isConfirmText(text)).toBe(false);
  });

  it("o hash do número é estável, sem o telefone em claro e igual para o mesmo número com máscara", () => {
    const a = hashPhoneForDedup("558499998888");
    expect(a).toBe(hashPhoneForDedup("+55 (84) 9999-8888"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("558499998888");
    expect(hashPhoneForDedup("558499998889")).not.toBe(a);
  });
});
