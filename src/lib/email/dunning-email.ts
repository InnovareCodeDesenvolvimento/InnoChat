import { buildEmailCopy, type DunningCopyData } from "@/core/billing/dunning-copy";
import type { DunningStep } from "@/core/billing/dunning-policy";
import { button, fallbackLink, heading, invoiceCard, note, paragraph, pixBlock, renderEmailHtml, renderEmailText, type EmailContext } from "./layout";
import {
  invoiceDueReminderEmail,
  invoiceGeneratedEmail,
  paymentConfirmedEmail,
  sanitizeSubject,
  subscriptionCancelEmail,
  subscriptionSuspendedEmail,
} from "./templates";

/**
 * E-mail de qualquer etapa da régua. As etapas que já tinham modelo (fatura gerada, véspera/dia,
 * suspensão, recibo, cancelamento automático) continuam nele, agora com o Pix vigente e os prazos novos;
 * as demais saem do texto de `buildEmailCopy`. Devolve `null` para etapa sem e-mail (DUE_D3).
 */

export type DunningEmailExtra = {
  /** Dias de guarda dos dados, só no cancelamento automático. */
  retentionUntilBr?: string | null;
  clientsUrl?: string;
};

export type RenderedEmail = { subject: string; html: string; text: string };

const REASON = (tenantName: string) => `Você recebeu este e-mail porque é o responsável pela assinatura de "${tenantName}" no InnoChat.`;

export function renderDunningEmail(step: DunningStep, d: DunningCopyData, ctx: EmailContext, extra: DunningEmailExtra = {}): RenderedEmail | null {
  switch (step) {
    case "INVOICE_CREATED":
      return invoiceGeneratedEmail({ tenantName: d.tenantName, amountReais: d.amount, dueDateBr: d.dueDate ?? "", pixCopyPaste: d.pixCopyPaste, billingUrl: d.billingUrl, ctx });
    case "DUE_D1":
    case "DUE_D0":
      return invoiceDueReminderEmail({ tenantName: d.tenantName, amountReais: d.amount, dueDateBr: d.dueDate ?? "", billingUrl: d.billingUrl, dueToday: step === "DUE_D0", pixCopyPaste: d.pixCopyPaste, ctx });
    case "SUSPENDED":
      return subscriptionSuspendedEmail({
        tenantName: d.tenantName,
        billingUrl: d.billingUrl,
        trialNotConverted: d.trialNotConverted,
        cancelInDays: d.trialNotConverted ? (d.unpaidDays ?? undefined) : undefined,
        cancelDateBr: d.trialNotConverted ? null : d.cancelDate,
        trialClients: d.trial?.clients,
        pixCopyPaste: d.pixCopyPaste,
        ctx,
      });
    case "PAYMENT_CONFIRMED":
      return paymentConfirmedEmail({
        tenantName: d.tenantName,
        amountReais: d.amount,
        paidDateBr: d.paidDate ?? "",
        activeUntilBr: d.activeUntil ?? "",
        billingUrl: d.billingUrl,
        ctx,
      });
    case "AUTO_CANCELED":
      return subscriptionCancelEmail({
        tenantName: d.tenantName,
        immediate: true,
        endsAtBr: d.cancelDate ?? "",
        retentionDays: d.retentionDays,
        clientsUrl: extra.clientsUrl ?? d.panelUrl,
        billingUrl: d.billingUrl,
        automatic: { unpaidDays: d.unpaidDays ?? 60, trialNotConverted: d.trialNotConverted, retentionUntilBr: extra.retentionUntilBr ?? "" },
        ctx,
      });
    default:
      break;
  }

  const copy = buildEmailCopy(step, d);
  if (!copy) return null;
  const url = copy.ctaTarget === "PANEL" ? d.panelUrl : d.billingUrl;
  const pix = copy.showPix ? d.pixCopyPaste?.trim() || null : null;
  const rows = [
    heading(copy.heading),
    ...copy.paragraphs.map((p) => paragraph(p)),
    copy.card ? invoiceCard({ tenantName: d.tenantName, amount: d.amount, dateLabel: copy.card.dateLabel, dateValue: copy.card.dateValue }) : "",
    pix ? pixBlock(pix) : "",
    button(url, copy.cta),
    fallbackLink(url),
    copy.note ? note(copy.note) : "",
  ].join("\n");
  const text = [
    ...copy.paragraphs,
    ...(copy.card ? [`${copy.card.dateLabel}: ${copy.card.dateValue}\nValor: ${d.amount}`] : []),
    ...(pix ? [`Pix copia e cola:\n${pix}`] : []),
    `${copy.cta}:\n${url}`,
    ...(copy.note ? [copy.note] : []),
  ].join("\n\n");
  const footerReason = REASON(d.tenantName);
  return {
    subject: sanitizeSubject(copy.subject),
    html: renderEmailHtml({ title: copy.subject, preheader: copy.preheader, contentRows: rows, footerReason, ctx }),
    text: renderEmailText({ body: text, footerReason, ctx }),
  };
}
