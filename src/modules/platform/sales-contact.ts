import { cache } from "react";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { formatBrPhoneDisplay, normalizeBrPhoneToE164 } from "@/core/contact/br-phone";
import { DomainError } from "@/lib/errors";

/**
 * WhatsApp comercial da plataforma (botão "Tirar dúvidas" da landing). Vive em `PlatformSettings`
 * (`salesWhatsappE164`, só dígitos com DDI: `558431132584`), cadastrado pelo admin em
 * Configurações. Não é segredo — a landing pública o expõe no link `wa.me`.
 */

export type SalesWhatsapp = { e164: string; display: string };

function toView(e164: string | null | undefined): SalesWhatsapp | null {
  if (!e164) return null;
  return { e164, display: formatBrPhoneDisplay(e164) };
}

/** Leitura para o admin. Pode lançar (erro de banco) — quem chama é action com `runAction`. */
export async function getPlatformSalesWhatsapp(): Promise<SalesWhatsapp | null> {
  const row = await getPrisma().platformSettings.findUnique({ where: { id: 1 }, select: { salesWhatsappE164: true } });
  return toView(row?.salesWhatsappE164);
}

/**
 * Grava (normalizando para E.164) ou limpa (`null`/vazio/só espaços). Telefone inválido ->
 * `DomainError("INVALID_PHONE")`.
 */
export async function updatePlatformSalesWhatsapp(raw: string | null, updatedByUserId: string): Promise<SalesWhatsapp | null> {
  const trimmed = (raw ?? "").trim();
  let e164: string | null = null;
  if (trimmed) {
    e164 = normalizeBrPhoneToE164(trimmed);
    if (!e164) {
      throw new DomainError("INVALID_PHONE", "Telefone inválido — informe DDD + número, ex.: (84) 3113-2584.");
    }
  }
  const row = await getPrisma().platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, salesWhatsappE164: e164, updatedByUserId },
    update: { salesWhatsappE164: e164, updatedByUserId },
    select: { salesWhatsappE164: true },
  });
  return toView(row.salesWhatsappE164);
}

/**
 * Leitura PÚBLICA para a landing. NUNCA lança: o `next build` roda sem banco, e uma falha aqui
 * não pode derrubar a página — devolve `null` (botão some). `cache()` só deduplica dentro do
 * mesmo render.
 */
export const getPublicSalesWhatsapp = cache(async (): Promise<SalesWhatsapp | null> => {
  try {
    return await getPlatformSalesWhatsapp();
  } catch (err) {
    logger.warn("platform.sales_whatsapp.public_read_failed", { errorMessage: err instanceof Error ? err.message : String(err) });
    return null;
  }
});
