import { subHours } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { STEP_POLICY, type DunningStep } from "@/core/billing";
import { findOwnerContact } from "../service";
import { maskEmail } from "./outbox";

/**
 * Para quem vai o e-mail da régua (decisão D4, docs/regua-de-cobranca.md §2.5): `Tenant.billingEmail`
 * recebe tudo; o OWNER continua recebendo as etapas CRÍTICAS e o recibo, sem repetir quando os dois são o
 * mesmo endereço. Sem `billingEmail`, o OWNER recebe tudo (como sempre foi).
 */

export type NoticeRecipients = {
  emails: string[];
  ownerFirstName: string | null;
  whatsappE164: string | null;
  whatsappOptedOut: boolean;
  /** O assinante respondeu SIM ao número da plataforma (`Tenant.billingWhatsappConfirmedAt`). */
  whatsappConfirmed: boolean;
  /** `BILLING_EMAIL` quando o e-mail do financeiro está entre os destinos; senão o dono (`OWNER`). */
  emailKind: "OWNER" | "BILLING_EMAIL";
};

function clean(email: string | null | undefined): string | null {
  const value = email?.trim();
  return value ? value : null;
}

/** Contato de cobrança ainda NÃO confirmado recebe no máximo 1 mensagem por este intervalo. */
const UNCONFIRMED_CONTACT_INTERVAL_HOURS = 24;

export async function resolveNoticeRecipients(tenantId: string, step: DunningStep, now: Date = new Date()): Promise<NoticeRecipients> {
  const [tenant, owner] = await Promise.all([
    getPrisma().tenant.findUnique({
      where: { id: tenantId },
      select: { billingEmail: true, billingWhatsappE164: true, billingWhatsappOptOutAt: true, billingWhatsappConfirmedAt: true },
    }),
    findOwnerContact(tenantId),
  ]);
  let billing = clean(tenant?.billingEmail);
  const ownerEmail = clean(owner?.email);
  // O e-mail do financeiro é digitado por quem cadastrou e não tem confirmação de posse: sem ela, só 1 mensagem por
  // dia (nunca vira canal de spam para um endereço de terceiro). Passando disso, o aviso vai ao OWNER, que é verificado.
  if (billing && billing.toLowerCase() !== ownerEmail?.toLowerCase()) {
    const recent = await getPrisma().billingNotice.count({
      where: { tenantId, channel: "EMAIL", status: "SENT", sentAt: { gt: subHours(now, UNCONFIRMED_CONTACT_INTERVAL_HOURS) }, recipientMasked: { contains: maskEmail(billing) } },
    });
    if (recent > 0) billing = null;
  }
  const policy = STEP_POLICY[step];
  const both = policy.critical || step === "PAYMENT_CONFIRMED";
  const wanted = billing ? (both ? [billing, ownerEmail] : [billing]) : [ownerEmail];

  const emails: string[] = [];
  const seen = new Set<string>();
  for (const email of wanted) {
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return {
    emails,
    ownerFirstName: owner?.firstName ?? null,
    whatsappE164: tenant?.billingWhatsappE164 ?? null,
    whatsappOptedOut: tenant?.billingWhatsappOptOutAt != null,
    whatsappConfirmed: tenant?.billingWhatsappConfirmedAt != null,
    emailKind: billing ? "BILLING_EMAIL" : "OWNER",
  };
}
