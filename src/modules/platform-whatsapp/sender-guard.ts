import { getPrisma } from "@/lib/db/prisma";
import { digitsOnly, phoneDigitVariants } from "@/core/platform-whatsapp/rules";

/**
 * Trava anti-loop (docs/regua-de-cobranca.md §2.4, trava 1): "este remetente é um número que JÁ foi
 * do WhatsApp da plataforma?". Considera TODOS os papéis (ACTIVE, PENDING e RETIRED): o chip antigo
 * pode continuar com WhatsApp aberto em algum aparelho. Módulo leve (só Prisma) porque é chamado em
 * TODO `POST /messages/claim`. Lista em cache de 60 s, invalidada quando um número é ativado.
 */

const CACHE_TTL_MS = 60_000;

let cache: { at: number; digits: Set<string> } | null = null;

export function invalidatePlatformSenderCache(): void {
  cache = null;
}

async function loadPlatformDigits(nowMs: number): Promise<Set<string>> {
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.digits;
  const rows = await getPrisma().platformWhatsappConnection.findMany({
    where: { phoneE164: { not: null } },
    select: { phoneE164: true },
  });
  const digits = new Set<string>();
  for (const row of rows) {
    for (const variant of phoneDigitVariants(row.phoneE164!)) digits.add(variant);
  }
  cache = { at: nowMs, digits };
  return digits;
}

/** `jid` ("5584999998888@s.whatsapp.net"), dígitos puros ou E.164 com "+". `@lid` nunca casa (não há número). */
export async function isPlatformSender(jidOrPhone: string | null | undefined, nowMs: number = Date.now()): Promise<boolean> {
  if (!jidOrPhone || jidOrPhone.endsWith("@lid")) return false;
  const digits = digitsOnly(jidOrPhone.split("@")[0] ?? "");
  if (!digits) return false;
  return (await loadPlatformDigits(nowMs)).has(digits);
}
