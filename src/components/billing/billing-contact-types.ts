import type { Result } from "@/lib/result";

/**
 * Contrato de `updateBillingContactAction` (Vega, F2; docs/regua-de-cobranca.md §3.3).
 * - `billingEmail`: e-mail do financeiro; `null` volta a usar o e-mail do dono.
 * - `billingWhatsapp`: E.164 do Brasil com "+" (ex.: "+5584999990000"); `null` apaga.
 * - `optOut`: `true` = a empresa NÃO quer cobrança pelo WhatsApp.
 */
export type BillingContactInput = {
  billingEmail?: string | null;
  billingWhatsapp?: string | null;
  optOut?: boolean;
  /** "Salvar mesmo assim": pula a conferência de "esse número tem WhatsApp?" (erro `NO_WHATSAPP`). */
  skipWhatsappCheck?: boolean;
};

export type SaveBillingContact = (tenantSlug: string, input: BillingContactInput) => Promise<Result<unknown>>;

export type BillingContactData = {
  billingEmail: string | null;
  /** Só dígitos com DDI (`Tenant.billingWhatsappE164`), ou null. */
  billingWhatsappE164: string | null;
  optedOut: boolean;
  /** O assinante respondeu SIM ao número da plataforma (posse confirmada). `false` = "aguardando confirmação". */
  whatsappConfirmed?: boolean;
  ownerEmail: string | null;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isPlausibleEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}
