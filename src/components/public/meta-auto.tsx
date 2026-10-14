import { getPublicPixelId } from "@/modules/meta/config";
import { MetaAutoLoad } from "./meta-auto-load";

/**
 * Tracking do Pixel do Meta **sem banner de consentimento** — para rotas onde a
 * pergunta trava a conversão (decisão do dono 2026-10-14: tela de /cadastro).
 * Carrega o Pixel direto e marca `granted` no localStorage. O Pixel continua
 * contando PageView; o usuário não precisa fazer nada.
 *
 * Se um dia isso virar problema jurídico, o caminho de volta é simples: trocar
 * este componente pelo `MetaTracking` na página afetada.
 */
export async function MetaAutoTracking({ stripQuery = false }: { stripQuery?: boolean } = {}) {
  const pixelId = await getPublicPixelId();
  if (!pixelId) return null;
  return <MetaAutoLoad pixelId={pixelId} stripQuery={stripQuery} />;
}
