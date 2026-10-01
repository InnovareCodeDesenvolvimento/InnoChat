import { describe, expect, it } from "vitest";
import { buildEmailCopy, buildWhatsappMessages, type DunningCopyData } from "../dunning-copy";
import { DUNNING_STEPS, STEP_POLICY } from "../dunning-policy";
import { summarizeTrialUsage } from "../trial-usage";

const usage = summarizeTrialUsage({
  appointmentsByBot: 3,
  conversationsAnswered: 12,
  remindersSent: 2,
  returningClients: 0,
  botClients: 3,
  whatsappConnected: true,
  hasService: true,
  hasProfessional: true,
});
const almost = summarizeTrialUsage({ appointmentsByBot: 0, conversationsAnswered: 0, remindersSent: 0, returningClients: 0, botClients: 0, whatsappConnected: false, hasService: false, hasProfessional: false });

const data = (over: Partial<DunningCopyData> = {}): DunningCopyData => ({
  ownerName: "Ana",
  tenantName: "Salão da Ana",
  amount: "R$ 49,90",
  dueDate: "28/10/2026",
  billingUrl: "https://app.exemplo.com/salao/assinatura",
  panelUrl: "https://app.exemplo.com/salao/inicio",
  pixCopyPaste: "00020126pixcopiaecola",
  lastServiceDate: "31/10/2026",
  daysSuspended: 7,
  daysToCancel: 7,
  cancelDate: "31/12/2026",
  suspendedDate: "01/11/2026",
  retentionDays: 90,
  unpaidDays: 60,
  salesWhatsapp: "(84) 3113-2584",
  trialEndsDate: "04/10/2026",
  trialEndsTime: "12:00",
  trial: usage,
  paidDate: "27/10/2026",
  activeUntil: "27/11/2026",
  firstPayment: false,
  trialNotConverted: false,
  firstWhatsapp: false,
  ...over,
});

describe("textos da régua: guia de voz", () => {
  it("nenhum texto de nenhuma etapa tem travessão, 'prezado' ou fórmulas proibidas", () => {
    const variants: DunningCopyData[] = [data(), data({ trial: almost, ownerName: null, pixCopyPaste: null, firstWhatsapp: true }), data({ trialNotConverted: true, firstPayment: true })];
    for (const step of DUNNING_STEPS) {
      for (const d of variants) {
        const email = buildEmailCopy(step, d);
        const all = [...buildWhatsappMessages(step, d), ...(email ? [email.subject, email.preheader, email.heading, ...email.paragraphs, email.cta, email.note ?? ""] : [])].join("\n");
        expect(all, step).not.toMatch(/—|–/);
        expect(all.toLowerCase(), step).not.toMatch(/prezad|sem complica|de forma simples|tudo em um só lugar|potencializ|revolucion|vale lembrar/);
        expect(all, step).not.toMatch(/undefined|null|NaN/);
      }
    }
  });

  it("toda etapa com WhatsApp na política devolve mensagem, e as sem WhatsApp não devolvem", () => {
    for (const step of DUNNING_STEPS) {
      const messages = buildWhatsappMessages(step, data());
      expect(messages.length > 0, step).toBe(STEP_POLICY[step].whatsapp);
    }
  });

  it("toda etapa nova com e-mail tem texto; as de modelo próprio ficam com null", () => {
    const own = new Set(["INVOICE_CREATED", "DUE_D1", "DUE_D0", "SUSPENDED", "PAYMENT_CONFIRMED", "AUTO_CANCELED", "DUE_D3"]);
    for (const step of DUNNING_STEPS) {
      const copy = buildEmailCopy(step, data());
      if (own.has(step)) expect(copy, step).toBeNull();
      else expect(copy, step).not.toBeNull();
    }
  });
});

describe("WhatsApp: curto, com valor e link; Pix em mensagem separada", () => {
  it("fatura gerada: texto com valor, vencimento e link, e o Pix sozinho na segunda mensagem", () => {
    const [text, pix] = buildWhatsappMessages("INVOICE_CREATED", data());
    expect(text).toContain("R$ 49,90");
    expect(text).toContain("28/10/2026");
    expect(text).toContain("https://app.exemplo.com/salao/assinatura");
    expect(text).toContain("Responda SAIR");
    expect(pix).toBe("00020126pixcopiaecola");
  });

  it("sem Pix (Mercado Pago fora): uma mensagem só, mandando pagar pelo painel", () => {
    const messages = buildWhatsappMessages("DUE_D1", data({ pixCopyPaste: null }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("https://app.exemplo.com/salao/assinatura");
    expect(messages[0]).not.toContain("próxima mensagem");
  });

  it("o aviso de como parar de receber só vai na primeira mensagem da empresa (e sempre na fatura gerada)", () => {
    expect(buildWhatsappMessages("DUE_D1", data({ firstWhatsapp: false }))[0]).not.toContain("SAIR");
    expect(buildWhatsappMessages("DUE_D1", data({ firstWhatsapp: true }))[0]).toContain("Responda SAIR");
  });

  it("sem nome do dono o texto não inventa um", () => {
    const [text] = buildWhatsappMessages("GRACE_LAST", data({ ownerName: null }));
    expect(text.startsWith("Hoje é o último dia.")).toBe(true);
  });

  it("carência, suspensão e cancelamento citam as datas e o valor", () => {
    expect(buildWhatsappMessages("GRACE_D1", data())[0]).toContain("até o fim do dia 31/10/2026");
    expect(buildWhatsappMessages("SUSPENDED", data())[0]).toContain("R$ 49,90");
    expect(buildWhatsappMessages("CANCEL_WARN_1", data({ daysToCancel: 1, cancelDate: "31/12/2026" }))[0]).toContain("falta 1 dia");
    expect(buildWhatsappMessages("CANCEL_WARN_7", data())[0]).toContain("faltam 7 dias");
    expect(buildWhatsappMessages("AUTO_CANCELED", data())[0]).toContain("90 dias");
    expect(buildWhatsappMessages("SUSP_30", data({ daysSuspended: 31 }))[0]).toContain("há 31 dias");
    expect(buildWhatsappMessages("SUSP_7", data())[0]).toContain("(84) 3113-2584");
    expect(buildWhatsappMessages("SUSP_7", data({ salesWhatsapp: null }))[0]).not.toContain("chama a gente");
  });

  it("pagamento confirmado: renovação e primeiro pagamento", () => {
    expect(buildWhatsappMessages("PAYMENT_CONFIRMED", data())[0]).toContain("renovada até 27/11/2026");
    expect(buildWhatsappMessages("PAYMENT_CONFIRMED", data({ firstPayment: true }))[0]).toContain("Bem-vindo");
  });
});

describe("sequência do teste: dados reais e variação 'falta pouco'", () => {
  it("1º dia com resultados: cita os números reais", () => {
    const [text] = buildWhatsappMessages("TRIAL_DAY1", data());
    expect(text).toContain("o Inno já marcou 3 horários, respondeu 12 conversas e mandou 2 lembretes");
  });

  it("1º dia sem nenhum resultado: não cobra, ajuda a ligar o que falta", () => {
    const [text] = buildWhatsappMessages("TRIAL_DAY1", data({ trial: almost }));
    expect(text).toContain("Falta pouco");
    expect(text).toContain("conectar o número de WhatsApp da empresa");
    expect(text).not.toMatch(/marcou|respondeu/);
    const email = buildEmailCopy("TRIAL_DAY1", data({ trial: almost }));
    expect(email?.paragraphs.join(" ")).toContain("O que falta: conectar o número de WhatsApp da empresa");
    expect(email?.ctaTarget).toBe("PANEL");
  });

  it("véspera com resultado e sem resultado", () => {
    expect(buildWhatsappMessages("TRIAL_T1", data())[0]).toContain("Até agora o Inno marcou 3 horários");
    expect(buildWhatsappMessages("TRIAL_T1", data({ trial: almost }))[0]).not.toContain("Até agora");
    expect(buildWhatsappMessages("TRIAL_T1", data())[0]).toContain("amanhã às 12:00");
  });

  it("teste suspenso: fala dos clientes que marcaram pelo WhatsApp só quando existem", () => {
    expect(buildWhatsappMessages("SUSPENDED", data({ trialNotConverted: true }))[0]).toContain("3 clientes que marcaram pelo WhatsApp vão ficar sem resposta");
    expect(buildWhatsappMessages("SUSPENDED", data({ trialNotConverted: true, trial: almost }))[0]).not.toContain("clientes que marcaram");
  });
});
