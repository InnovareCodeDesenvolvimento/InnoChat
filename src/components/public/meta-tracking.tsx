import { getPublicPixelId } from "@/modules/meta/config";
import { MetaPixel } from "./meta-pixel";

/**
 * Tracking do Pixel do Meta com banner de consentimento (LGPD). Server Component:
 * lê o ID do Pixel (só se o Admin ligou) e entrega ao banner. Sem Pixel, não
 * renderiza nada. Vai em landing, páginas de nicho e outras públicas de venda.
 * `stripQuery`: páginas cuja query pode carregar dado (cupom, token) — NUNCA
 * montar em página cuja URL leva token (ex.: /cadastro/google).
 *
 * Para a tela de /cadastro, o dono decidiu (2026-10-14) que a pergunta de
 * consentimento trava a conversão. Use `MetaAutoTracking` ali em vez deste.
 */
export async function MetaTracking({ stripQuery = false }: { stripQuery?: boolean } = {}) {
  const pixelId = await getPublicPixelId();
  return pixelId ? <MetaPixel pixelId={pixelId} stripQuery={stripQuery} /> : null;
}
