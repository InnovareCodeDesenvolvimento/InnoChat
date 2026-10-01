import type { DunningStep } from "./dunning-policy";
import { describeMissingStep, describeStrandedClients, describeTrialResults, type TrialUsage } from "./trial-usage";

/**
 * Textos da régua de cobrança (docs/regua-de-cobranca.md §2.3 e §2.3.1), pt-BR, seguindo
 * `docs/guia-de-voz.md`: frases curtas, "você" para o dono, sem travessão, sem fórmula pronta. Puros: o
 * despachante monta `DunningCopyData` com o estado ATUAL (valor, datas, uso do teste) na hora do envio.
 *
 * WhatsApp: curto, com o valor e o link. O Pix copia e cola vai numa mensagem separada, sozinho, para o
 * dono poder tocar e copiar. E-mail: `buildEmailCopy` cobre as etapas novas; as que já tinham modelo
 * (fatura gerada, véspera/dia, suspensão, pagamento, cancelamento) continuam nos modelos de `lib/email`.
 */

export type DunningCopyData = {
  /** Primeiro nome do dono; `null` quando não há nome cadastrado (o texto some com o nome, sem inventar). */
  ownerName: string | null;
  tenantName: string;
  /** "R$ 49,90". */
  amount: string;
  /** Vencimento da fatura ("28/10/2026"). */
  dueDate: string | null;
  /** Tela Assinatura. */
  billingUrl: string;
  /** Tela inicial do painel (passos do teste). */
  panelUrl: string;
  pixCopyPaste: string | null;
  /** Último dia em que o bot ainda atende na carência ("31/10/2026"). */
  lastServiceDate: string | null;
  /** Dias desde que o bot parou (calculado no envio). */
  daysSuspended: number | null;
  /** Dias até o encerramento automático e a data dele. */
  daysToCancel: number | null;
  cancelDate: string | null;
  /** Dia em que a conta foi suspensa ("01/11/2026"). */
  suspendedDate: string | null;
  retentionDays: number;
  /** Dias sem pagamento até o encerramento (60, ou 7 no teste). */
  unpaidDays: number | null;
  /** WhatsApp comercial para "conversar sobre o plano", já formatado, ou `null`. */
  salesWhatsapp: string | null;
  /** Fim do teste: data e hora no fuso da empresa. */
  trialEndsDate: string | null;
  trialEndsTime: string | null;
  trial: TrialUsage | null;
  /** Pagamento confirmado. */
  paidDate: string | null;
  activeUntil: string | null;
  /** Primeiro pagamento da empresa (vira "bem-vindo"). */
  firstPayment: boolean;
  /** `true` na suspensão e no cancelamento de quem nunca pagou. */
  trialNotConverted: boolean;
  /** Primeira mensagem de WhatsApp da cobrança para esta empresa: leva o aviso de como parar de receber. */
  firstWhatsapp: boolean;
};

const OPT_OUT_FOOTER = "Não quer receber estes avisos por aqui? Responda SAIR.";

function hello(d: DunningCopyData): string {
  return d.ownerName ? `Oi, ${d.ownerName}!` : "Oi!";
}

function name(d: DunningCopyData): string {
  return d.ownerName ?? "";
}

/** "Fulano, texto" ou só "Texto", conforme haja nome. */
function addressed(d: DunningCopyData, text: string): string {
  return d.ownerName ? `${d.ownerName}, ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

function daysWord(n: number): string {
  return n === 1 ? "1 dia" : `${n} dias`;
}

function results(d: DunningCopyData): string | null {
  return d.trial ? describeTrialResults(d.trial) : null;
}

function pixLine(d: DunningCopyData, withPix: string, withoutPix: string): string {
  return d.pixCopyPaste ? withPix : withoutPix;
}

/**
 * Mensagens de WhatsApp da etapa, na ordem de envio (a primeira é o texto; a segunda, quando existe, é só o
 * Pix copia e cola). Etapa sem WhatsApp devolve lista vazia.
 */
export function buildWhatsappMessages(step: DunningStep, d: DunningCopyData): string[] {
  const link = d.billingUrl;
  const pix = d.pixCopyPaste;
  const withPix = (text: string): string[] => (pix ? [text, pix] : [text]);
  const first = (messages: string[]): string[] => {
    if (!d.firstWhatsapp || messages.length === 0) return messages;
    return [`${messages[0]}\n\n${OPT_OUT_FOOTER}`, ...messages.slice(1)];
  };

  switch (step) {
    case "INVOICE_CREATED": {
      const text = `${hello(d)} A fatura do InnoChat de ${d.tenantName} já está disponível: ${d.amount}, com vencimento em ${d.dueDate}. ${pixLine(d, "O código Pix vai na próxima mensagem. Se preferir, pague pelo painel:", "Pague pelo painel:")} ${link}`;
      return withPix(`${text}\n\n${OPT_OUT_FOOTER}`);
    }
    case "DUE_D1":
      return first(
        withPix(`${hello(d)} Passando pra lembrar que a fatura do InnoChat vence amanhã (${d.dueDate}). Valor: ${d.amount}. ${pixLine(d, "O Pix vai na mensagem seguinte. ", "")}Pelo painel: ${link}\nSe você já pagou, pode ignorar.`),
      );
    case "DUE_D0":
      return first(
        withPix(`Bom dia${d.ownerName ? `, ${name(d)}` : ""}! A fatura do InnoChat de ${d.tenantName} vence hoje: ${d.amount}. Pague até as 23h59 pro bot não parar: ${link}\nAssim que o Pix cair, a confirmação chega por aqui.`),
      );
    case "GRACE_D1":
      return first(
        withPix(`${addressed(d, "a fatura do InnoChat venceu ontem.")} O bot de ${d.tenantName} continua atendendo até o fim do dia ${d.lastServiceDate}. Pra não parar, pague o Pix de ${d.amount}: ${link}`),
      );
    case "GRACE_LAST":
      return first(
        withPix(`${addressed(d, "hoje é o último dia.")} Se a fatura de ${d.amount} não for paga até a meia-noite, o bot de ${d.tenantName} para de responder seus clientes amanhã. Pague aqui: ${link}`),
      );
    case "SUSPENDED": {
      if (d.trialNotConverted) {
        const clients = d.trial && d.trial.clients > 0 ? ` ${describeStrandedClients(d.trial.clients)}.` : "";
        return first(withPix(`${addressed(d, "seu teste do InnoChat acabou e o bot de")} ${d.tenantName} parou.${clients} Assine por ${d.amount} e ele volta na hora: ${link}`));
      }
      return first(
        withPix(
          `${addressed(d, "o atendimento automático de")} ${d.tenantName} foi pausado porque a fatura de ${d.amount} não foi paga. Seus clientes continuam conseguindo mandar mensagem, mas o bot não responde. Pague o Pix e ele volta em poucos minutos: ${link}`,
        ),
      );
    }
    case "SUSP_7":
    case "SUSP_30": {
      const sales = d.salesWhatsapp ? ` Se quiser conversar sobre o plano, chama a gente no ${d.salesWhatsapp}.` : "";
      return first([
        `${addressed(d, "o bot de")} ${d.tenantName} está parado há ${daysWord(d.daysSuspended ?? (step === "SUSP_7" ? 7 : 30))}. Está tudo guardado: agenda, clientes e serviços. Pra voltar, é só pagar ${d.amount}: ${link}${sales}`,
      ]);
    }
    case "CANCEL_WARN_7":
    case "CANCEL_WARN_1": {
      const left = d.daysToCancel ?? (step === "CANCEL_WARN_7" ? 7 : 1);
      const lead = left === 1 ? "falta 1 dia" : `faltam ${left} dias`;
      return first([
        `${addressed(d, `${lead} pra conta de`)} ${d.tenantName} ser encerrada (${d.cancelDate}). Depois disso os números são desconectados e, ${d.retentionDays} dias depois, os dados dos seus clientes são anonimizados. Pra manter, pague ${d.amount}: ${link}\nPra guardar a lista de clientes, exporte o CSV na tela Clientes.`,
      ]);
    }
    case "AUTO_CANCELED":
      return first([
        `${addressed(d, "a conta de")} ${d.tenantName} no InnoChat foi encerrada hoje. Os dados ficam guardados por ${d.retentionDays} dias. Se quiser voltar, a reativação é pelo painel: ${link}`,
      ]);
    case "PAYMENT_CONFIRMED":
      return first([
        d.firstPayment
          ? `Bem-vindo ao InnoChat${d.ownerName ? `, ${name(d)}` : ""}! Recebemos ${d.amount} de ${d.tenantName} em ${d.paidDate}. Sua assinatura vale até ${d.activeUntil}. Obrigado.`
          : `Pagamento recebido! ${d.amount} de ${d.tenantName}, confirmado em ${d.paidDate}. Sua assinatura está renovada até ${d.activeUntil}. Obrigado.`,
      ]);
    case "TRIAL_DAY1": {
      const done = results(d);
      if (done) return first([`${hello(d)} Primeiro dia do InnoChat em ${d.tenantName}: o Inno já ${done}. Seu teste vai até ${d.trialEndsDate} às ${d.trialEndsTime}. Qualquer dúvida, o painel tem ajuda em cada tela: ${d.panelUrl}`]);
      return first([`${hello(d)} Falta pouco pro Inno começar a atender ${d.tenantName}: ${d.trial ? describeMissingStep(d.trial.missing) : "conectar o WhatsApp"}. Leva poucos minutos: ${d.panelUrl}`]);
    }
    case "TRIAL_T1": {
      const done = results(d);
      const lead = done ? `Até agora o Inno ${done}. ` : "";
      return first(withPix(`${hello(d)} Seu teste do InnoChat termina amanhã às ${d.trialEndsTime}. ${lead}Pro bot de ${d.tenantName} continuar atendendo, é só assinar com Pix (${d.amount}): ${link}`));
    }
    case "TRIAL_T0":
      return first(withPix(`${addressed(d, "hoje é o último dia do teste.")} Assine pro bot de ${d.tenantName} não parar amanhã: ${d.amount} no Pix, ${link}`));
    case "TRIAL_CANCEL_WARN": {
      const left = d.daysToCancel ?? 2;
      return first([`${addressed(d, "a conta de teste de")} ${d.tenantName} será encerrada em ${daysWord(left)}. Se quiser continuar, assine pelo painel: ${link}`]);
    }
    default:
      return [];
  }
}

export type EmailCopy = {
  subject: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** Cartão com valor e data (vencimento ou fim do teste). */
  card: { dateLabel: string; dateValue: string } | null;
  showPix: boolean;
  cta: string;
  /** Link do botão: tela Assinatura ou o painel. */
  ctaTarget: "BILLING" | "PANEL";
  note: string | null;
};

function resultsParagraph(d: DunningCopyData, lead: string): string | null {
  const done = results(d);
  return done ? `${lead} o Inno ${done}.` : null;
}

/**
 * E-mail das etapas novas. `null` para as que usam modelo próprio de `lib/email` (INVOICE_CREATED, DUE_D1,
 * DUE_D0, SUSPENDED, PAYMENT_CONFIRMED, AUTO_CANCELED) e para as que não têm e-mail (DUE_D3).
 */
export function buildEmailCopy(step: DunningStep, d: DunningCopyData): EmailCopy | null {
  const t = d.tenantName;
  switch (step) {
    case "GRACE_D1":
      return {
        subject: `Sua fatura venceu ontem (${t})`,
        preheader: `O bot continua atendendo até o fim do dia ${d.lastServiceDate}.`,
        heading: "Sua fatura venceu",
        paragraphs: [
          `A fatura de ${d.amount} do InnoChat venceu em ${d.dueDate}. Ainda dá tempo: o bot continua atendendo até o fim do dia ${d.lastServiceDate}. Depois disso ele para de responder até o pagamento.`,
        ],
        card: { dateLabel: "Venceu em", dateValue: d.dueDate ?? "" },
        showPix: true,
        cta: "Pagar com Pix",
        ctaTarget: "BILLING",
        note: "Se você já pagou, pode ignorar este aviso. A confirmação chega sozinha.",
      };
    case "GRACE_D2":
      return {
        subject: `A fatura de ${t} segue em aberto`,
        preheader: `O bot atende até o fim do dia ${d.lastServiceDate}.`,
        heading: "Sua fatura segue em aberto",
        paragraphs: [`O bot continua atendendo até o fim do dia ${d.lastServiceDate}. Pague ${d.amount} pelo painel para ele não parar.`],
        card: { dateLabel: "Venceu em", dateValue: d.dueDate ?? "" },
        showPix: true,
        cta: "Pagar com Pix",
        ctaTarget: "BILLING",
        note: "Se você já pagou, pode ignorar este aviso.",
      };
    case "GRACE_LAST":
      return {
        subject: `Último dia para pagar a fatura (${t})`,
        preheader: "Depois da meia-noite o bot para de responder.",
        heading: "Hoje é o último dia",
        paragraphs: [`Se a fatura de ${d.amount} não for paga até a meia-noite, o bot de "${t}" para de responder seus clientes amanhã. Seus dados continuam guardados.`],
        card: { dateLabel: "Venceu em", dateValue: d.dueDate ?? "" },
        showPix: true,
        cta: "Pagar com Pix",
        ctaTarget: "BILLING",
        note: "Se você já pagou, pode ignorar este aviso.",
      };
    case "SUSP_3":
    case "SUSP_7":
    case "SUSP_15":
    case "SUSP_30":
    case "SUSP_45": {
      const days = d.daysSuspended ?? Number(step.slice(5));
      const cancel = d.cancelDate ? `Se a fatura não for paga até ${d.cancelDate}, a conta é encerrada.` : null;
      return {
        subject: `O bot de ${t} está parado há ${daysWord(days)}`,
        preheader: "Sua agenda e seus clientes continuam guardados.",
        heading: "O bot está parado",
        paragraphs: [
          `Sua agenda e seus clientes continuam guardados. Para o bot voltar a responder, pague ${d.amount} pelo painel. A confirmação é automática.`,
          ...(cancel ? [cancel] : []),
        ],
        card: null,
        showPix: false,
        cta: "Pagar e reativar",
        ctaTarget: "BILLING",
        note: "Se você já pagou, pode ignorar este aviso.",
      };
    }
    case "CANCEL_WARN_7":
    case "CANCEL_WARN_1": {
      const left = d.daysToCancel ?? (step === "CANCEL_WARN_7" ? 7 : 1);
      return {
        subject: left === 1 ? `Sua conta no InnoChat será encerrada amanhã (${t})` : `Sua conta no InnoChat será encerrada em ${left} dias (${t})`,
        preheader: `Pague ${d.amount} para manter a conta.`,
        heading: "Sua conta vai ser encerrada",
        paragraphs: [
          `A conta de "${t}" será encerrada em ${d.cancelDate} se a fatura de ${d.amount} continuar em aberto.`,
          `Depois do encerramento, os números de WhatsApp são desconectados e, ${d.retentionDays} dias depois, os dados dos seus clientes são anonimizados.`,
          "Quer guardar a lista de clientes? Exporte o CSV pela tela Clientes antes dessa data.",
        ],
        card: null,
        showPix: false,
        cta: "Pagar e manter minha conta",
        ctaTarget: "BILLING",
        note: "Se você já pagou, pode ignorar este aviso.",
      };
    }
    case "TRIAL_DAY1": {
      const done = resultsParagraph(d, "Em um dia,");
      const until = d.trialEndsDate ? `Seu teste vai até ${d.trialEndsDate}, às ${d.trialEndsTime}. Para continuar depois disso, é só assinar com Pix.` : "";
      if (done) {
        return {
          subject: `Seu primeiro dia com o Inno em ${t}`,
          preheader: "Veja o que o Inno já fez.",
          heading: "Primeiro dia: veja o que o Inno fez",
          paragraphs: [done, until].filter(Boolean),
          card: null,
          showPix: false,
          cta: "Ver minha assinatura",
          ctaTarget: "BILLING",
          note: null,
        };
      }
      return {
        subject: `Falta pouco pro Inno atender ${t}`,
        preheader: "Leva poucos minutos.",
        heading: "Falta pouco para o Inno começar",
        paragraphs: [
          `O Inno ainda não atendeu ninguém em "${t}". O que falta: ${d.trial ? describeMissingStep(d.trial.missing) : "conectar o WhatsApp"}.`,
          "Leva poucos minutos e o bot já começa a responder seus clientes.",
        ],
        card: null,
        showPix: false,
        cta: "Abrir o painel",
        ctaTarget: "PANEL",
        note: null,
      };
    }
    case "TRIAL_T1": {
      const done = resultsParagraph(d, "Até agora,");
      return {
        subject: `Seu teste do InnoChat termina amanhã (${t})`,
        preheader: `Termina amanhã às ${d.trialEndsTime}.`,
        heading: "Seu teste termina amanhã",
        paragraphs: [
          ...(done ? [done] : []),
          `Seu teste termina amanhã, às ${d.trialEndsTime}. Para o bot de "${t}" seguir atendendo, assine com Pix: ${d.amount} por mês.`,
        ],
        card: { dateLabel: "Teste termina", dateValue: `${d.trialEndsDate ?? ""} às ${d.trialEndsTime ?? ""}`.trim() },
        showPix: true,
        cta: "Assinar com Pix",
        ctaTarget: "BILLING",
        note: null,
      };
    }
    case "TRIAL_T0": {
      const done = resultsParagraph(d, "Até agora,");
      return {
        subject: `Seu teste termina hoje às ${d.trialEndsTime} (${t})`,
        preheader: "Assine para o bot não parar amanhã.",
        heading: "Hoje é o último dia do teste",
        paragraphs: [...(done ? [done] : []), `Assine para o bot de "${t}" não parar amanhã. O valor é ${d.amount} por mês, no Pix.`],
        card: { dateLabel: "Teste termina", dateValue: `hoje, ${d.trialEndsTime ?? ""}`.trim() },
        showPix: true,
        cta: "Assinar com Pix",
        ctaTarget: "BILLING",
        note: null,
      };
    }
    case "TRIAL_SUSP_3": {
      const clients = d.trial && d.trial.clients > 0 ? ` ${describeStrandedClients(d.trial.clients)}.` : "";
      return {
        subject: `O bot de ${t} segue parado`,
        preheader: "Sua agenda e seus clientes continuam guardados.",
        heading: "O bot segue parado",
        paragraphs: [
          `O teste terminou e o bot está parado desde ${d.suspendedDate}. Sua agenda, seus clientes e seus serviços continuam guardados.${clients}`,
          "Para voltar, assine com Pix pela tela Assinatura.",
        ],
        card: null,
        showPix: false,
        cta: "Assinar agora",
        ctaTarget: "BILLING",
        note: d.cancelDate ? `A conta de teste é encerrada em ${d.cancelDate} se a assinatura não for feita.` : null,
      };
    }
    case "TRIAL_CANCEL_WARN": {
      const left = d.daysToCancel ?? 2;
      return {
        subject: `A conta de teste de ${t} será encerrada em ${daysWord(left)}`,
        preheader: "Última chance de assinar.",
        heading: "Última chance de assinar",
        paragraphs: [
          `Se a assinatura não for feita até ${d.cancelDate}, a conta de teste é encerrada e os números de WhatsApp são desconectados.`,
          `Seus dados ficam guardados por ${d.retentionDays} dias depois disso.`,
        ],
        card: null,
        showPix: false,
        cta: "Assinar agora",
        ctaTarget: "BILLING",
        note: null,
      };
    }
    default:
      return null;
  }
}
