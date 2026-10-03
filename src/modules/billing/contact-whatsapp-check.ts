import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { normalizeBrPhoneToE164 } from "@/core/contact/br-phone";
import { checkPlatformWhatsappNumber } from "@/modules/platform-whatsapp/sender";

export type WhatsappNumberCheck = (e164: string) => Promise<"EXISTS" | "NOT_FOUND" | "UNKNOWN">;

/**
 * Antes de salvar um WhatsApp de cobrança NOVO, pergunta à Evolution (pelo número da plataforma) se ele tem WhatsApp.
 *
 * Decisão: se a Evolution diz que NÃO tem, recusa com `NO_WHATSAPP` e a tela oferece "Salvar mesmo assim"
 * (`skipWhatsappCheck: true`). Recusar de vez seria perigoso: um falso negativo da conferência (9º dígito, número
 * recém-criado) impediria o dono de salvar um número certo, que é justamente o problema que isto resolve.
 * Qualquer dúvida (Evolution fora, prazo de 4 s estourado, sem número ativo) deixa salvar normalmente.
 * Só confere quando o número MUDA: reabrir e salvar o mesmo número, ou mexer só no e-mail, não gasta chamada.
 */
export async function assertBillingWhatsappReachable(
  tenantId: string,
  rawPhone: string | null | undefined,
  skip: boolean | undefined,
  check: WhatsappNumberCheck = (e164) => checkPlatformWhatsappNumber(e164),
): Promise<void> {
  if (skip) return;
  const trimmed = rawPhone?.trim() ?? "";
  if (!trimmed) return;
  const e164 = normalizeBrPhoneToE164(trimmed);
  if (!e164) return; // formato inválido: quem trata é o `updateBillingContact` (INVALID_PHONE)
  const current = await getPrisma().tenant.findUnique({ where: { id: tenantId }, select: { billingWhatsappE164: true } });
  if (current?.billingWhatsappE164 === e164) return;
  if ((await check(e164)) === "NOT_FOUND") {
    throw new DomainError("NO_WHATSAPP", "Esse número não tem WhatsApp. Confira os dígitos. Se tiver certeza de que está certo, salve mesmo assim.");
  }
}
