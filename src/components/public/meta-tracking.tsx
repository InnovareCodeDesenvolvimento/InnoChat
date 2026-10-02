import { getPublicPixelId } from "@/modules/meta/config";
import { MetaPixel } from "./meta-pixel";

/**
 * Server Component: lê o ID do Pixel (só se o Admin ligou) e entrega ao banner. Sem Pixel, não
 * renderiza nada: nenhum banner, nenhum script. Vai SÓ nas páginas públicas de venda, nunca no painel.
 */
export async function MetaTracking() {
  const pixelId = await getPublicPixelId();
  return pixelId ? <MetaPixel pixelId={pixelId} /> : null;
}
