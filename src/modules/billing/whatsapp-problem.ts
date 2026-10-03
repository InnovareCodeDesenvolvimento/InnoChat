import { getPrisma } from "@/lib/db/prisma";
import { WHATSAPP_INVALID_NUMBER_CODE } from "@/core/billing/dunning-labels";
import { formatBrPhoneDisplay } from "@/core/contact/br-phone";
import { phoneDigitVariants } from "@/core/platform-whatsapp/rules";

/**
 * Aviso "não conseguimos te mandar mensagem no WhatsApp" do painel do dono. SEM tabela nova: lê o que a régua já grava.
 *
 * Há problema quando existe um aviso de WhatsApp da empresa em `FAILED`, destinado AO NÚMERO ATUAL (trocar o número
 * apaga o aviso na hora), por número recusado (`WHATSAPP_INVALID_NUMBER`) ou por falha genérica já repetida
 * (2 tentativas ou mais; uma falha só pode ser soluço do nosso canal), nos últimos 30 dias, e nenhum envio de
 * WhatsApp para esse número deu certo DEPOIS dela. Um envio que dá certo (o mesmo aviso na nova tentativa ou
 * qualquer outro) faz o aviso sumir sozinho.
 */

const LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;
/** Falha genérica só conta como "número ruim" a partir desta tentativa. */
export const GENERIC_FAILURE_MIN_ATTEMPTS = 2;

export type BillingWhatsappProblem = { phoneDisplay: string; failedAt: string };

export async function getBillingWhatsappProblem(
  tenantId: string,
  contact: { billingWhatsappE164: string | null; optedOut: boolean },
  now: Date = new Date(),
): Promise<BillingWhatsappProblem | null> {
  if (!contact.billingWhatsappE164 || contact.optedOut) return null;
  const variants = phoneDigitVariants(contact.billingWhatsappE164);
  if (variants.length === 0) return null;
  const recipients = variants.flatMap((v) => [v, `+${v}`]);
  const prisma = getPrisma();

  const failed = await prisma.billingNotice.findFirst({
    where: {
      tenantId,
      channel: "WHATSAPP",
      status: "FAILED",
      recipient: { in: recipients },
      updatedAt: { gte: new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS) },
      OR: [{ lastErrorCode: WHATSAPP_INVALID_NUMBER_CODE }, { lastErrorCode: "WHATSAPP_SEND_FAILED", attempts: { gte: GENERIC_FAILURE_MIN_ATTEMPTS } }],
    },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  if (!failed) return null;

  const deliveredSince = await prisma.billingNotice.findFirst({
    where: { tenantId, channel: "WHATSAPP", status: "SENT", recipient: { in: recipients }, sentAt: { gt: failed.updatedAt } },
    select: { id: true },
  });
  if (deliveredSince) return null;

  return { phoneDisplay: formatBrPhoneDisplay(contact.billingWhatsappE164), failedAt: failed.updatedAt.toISOString() };
}
