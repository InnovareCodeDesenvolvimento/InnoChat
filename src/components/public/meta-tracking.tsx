import { getPublicPixelId } from "@/modules/meta/config";
import { MetaPixel } from "./meta-pixel";

/**
 * Server Component: lê o ID do Pixel (só se o Admin ligou) e entrega ao banner. Sem Pixel, não
 * renderiza nada: nenhum banner, nenhum script. Vai SÓ nas páginas públicas de venda, nunca no painel.
 * `stripQuery`: páginas de cadastro, onde a query pode carregar dado pessoal (nunca vai à Meta). NUNCA
 * monte isto em página cuja URL leva token (ex.: /cadastro/google).
 */
export async function MetaTracking({ stripQuery = false }: { stripQuery?: boolean } = {}) {
  const pixelId = await getPublicPixelId();
  return pixelId ? <MetaPixel pixelId={pixelId} stripQuery={stripQuery} /> : null;
}
