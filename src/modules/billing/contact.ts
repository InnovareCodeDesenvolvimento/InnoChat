import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { formatBrPhoneDisplay, normalizeBrPhoneToE164 } from "@/core/contact/br-phone";
import { findOwnerEmail } from "./service";

/**
 * Contato de cobrança da empresa (docs/regua-de-cobranca.md D4/D5, decisão do dono 2026-10-01): e-mail de
 * cobrança opcional, WhatsApp de cobrança e a chave de desligar o aviso por WhatsApp (opt-out).
 *
 * - `billingEmail` nulo = os avisos vão para o OWNER. Preenchido = recebe tudo; o OWNER continua recebendo as
 *   etapas críticas (sem repetir se for o mesmo endereço).
 * - `billingWhatsappE164` = só dígitos com DDI. D5: o aviso por WhatsApp é LIGADO para todos que informarem número;
 *   `billingWhatsappOptOutAt` preenchido = a empresa desligou (prova do pedido, LGPD). Responder SAIR ao número da
 *   plataforma grava a mesma marca (F4).
 */

export type BillingContactView = {
  billingEmail: string | null;
  /** Só dígitos com DDI, ou `null`. */
  billingWhatsappE164: string | null;
  /** Para exibir: "(84) 99999-8888". */
  billingWhatsappDisplay: string | null;
  optedOut: boolean;
  /** O assinante respondeu SIM ao número da plataforma (posse do número confirmada). */
  whatsappConfirmed: boolean;
  /** E-mail do OWNER mais antigo (para quem não preencheu e-mail de cobrança saber para onde vai). */
  ownerEmail: string | null;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX_LENGTH = 255;

export async function getBillingContact(tenantId: string): Promise<BillingContactView> {
  const [tenant, ownerEmail] = await Promise.all([
    getPrisma().tenant.findUnique({ where: { id: tenantId }, select: { billingEmail: true, billingWhatsappE164: true, billingWhatsappOptOutAt: true, billingWhatsappConfirmedAt: true } }),
    findOwnerEmail(tenantId),
  ]);
  if (!tenant) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
  return {
    billingEmail: tenant.billingEmail,
    billingWhatsappE164: tenant.billingWhatsappE164,
    billingWhatsappDisplay: tenant.billingWhatsappE164 ? formatBrPhoneDisplay(tenant.billingWhatsappE164) : null,
    optedOut: tenant.billingWhatsappOptOutAt !== null,
    whatsappConfirmed: tenant.billingWhatsappConfirmedAt !== null,
    ownerEmail,
  };
}

export type BillingContactUpdate = {
  /** `undefined` = não mexe; `null` ou vazio = apaga (volta a usar o e-mail do dono). */
  billingEmail?: string | null;
  /** `undefined` = não mexe; `null` ou vazio = apaga. Aceita máscara e "+55". */
  billingWhatsapp?: string | null;
  /** `true` = a empresa NÃO quer cobrança pelo WhatsApp; `false` = quer. */
  optOut?: boolean;
};

export async function updateBillingContact(tenantId: string, input: BillingContactUpdate, now: Date = new Date()): Promise<BillingContactView> {
  const data: {
    billingEmail?: string | null;
    billingWhatsappE164?: string | null;
    billingWhatsappOptOutAt?: Date | null;
    billingWhatsappConfirmedAt?: Date | null;
  } = {};

  if (input.billingEmail !== undefined) {
    const trimmed = input.billingEmail?.trim() ?? "";
    if (trimmed === "") {
      data.billingEmail = null;
    } else {
      if (trimmed.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(trimmed)) {
        throw new DomainError("INVALID_EMAIL", "Informe um e-mail válido, por exemplo financeiro@suaempresa.com.br.");
      }
      data.billingEmail = trimmed.toLowerCase();
    }
  }

  if (input.billingWhatsapp !== undefined) {
    const trimmed = input.billingWhatsapp?.trim() ?? "";
    if (trimmed === "") {
      data.billingWhatsappE164 = null;
    } else {
      const e164 = normalizeBrPhoneToE164(trimmed);
      if (!e164) throw new DomainError("INVALID_PHONE", "Informe o WhatsApp com DDD, por exemplo (84) 99999-8888.");
      data.billingWhatsappE164 = e164;
    }
    // Número novo = posse a confirmar de novo (o "SIM" valia para o número anterior). Mesmo número = mantém.
    const currentPhone = await getPrisma().tenant.findUnique({ where: { id: tenantId }, select: { billingWhatsappE164: true } });
    if (!currentPhone) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    if (currentPhone.billingWhatsappE164 !== (data.billingWhatsappE164 ?? null)) data.billingWhatsappConfirmedAt = null;
  }

  if (input.optOut !== undefined) {
    const current = await getPrisma().tenant.findUnique({ where: { id: tenantId }, select: { billingWhatsappOptOutAt: true } });
    if (!current) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    // Idempotente: desligar de novo mantém a data do primeiro pedido (é a prova do consentimento retirado).
    if (input.optOut) data.billingWhatsappOptOutAt = current.billingWhatsappOptOutAt ?? now;
    else data.billingWhatsappOptOutAt = null;
  }

  if (Object.keys(data).length > 0) await getPrisma().tenant.update({ where: { id: tenantId }, data });
  return getBillingContact(tenantId);
}
