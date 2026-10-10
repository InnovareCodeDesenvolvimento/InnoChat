import { effectiveStatus } from "./status";
import type { SubscriptionSnapshot } from "./types";
import { validateCpfCnpj } from "./document";

/**
 * Faixa "informe o CPF ou CNPJ para pagar com Pix" no painel (cadastro enxuto: o documento não é pedido no cadastro,
 * mas o Pix do Mercado Pago só nasce com ele). Só aparece para quem precisa agir e a tempo de agir:
 * - só o dono (OWNER);
 * - só no teste que ainda não virou pagamento, sem cancelamento agendado;
 * - só sem documento válido salvo;
 * - só nas últimas 24 h do teste (antes disso a faixa só atrapalharia o primeiro uso).
 * Puro, sem I/O: o layout do painel monta o retrato e chama.
 */

export const NEEDS_DOCUMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function shouldAskForDocument(input: {
  role: "OWNER" | "STAFF";
  /** `Tenant.document` como está no banco (dígitos), ou `null`. */
  document: string | null;
  subscription: SubscriptionSnapshot | null;
  now: Date;
}): boolean {
  const { role, document, subscription, now } = input;
  if (role !== "OWNER" || !subscription) return false;
  if (document && validateCpfCnpj(document).valid) return false;
  if (subscription.firstPaidAt !== null || subscription.cancelAtPeriodEnd) return false;
  if (effectiveStatus(subscription, now) !== "TRIALING") return false;
  const trialEnd = subscription.trialEndsAt ?? subscription.currentPeriodEnd;
  const left = trialEnd.getTime() - now.getTime();
  return left > 0 && left <= NEEDS_DOCUMENT_WINDOW_MS;
}
