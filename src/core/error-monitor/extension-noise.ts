/**
 * Erro que nasceu dentro de uma extensão do navegador (bloqueador, gerenciador de senha, tradutor...), não do nosso
 * código. Não há o que corrigir aqui, então o monitor não deve contar nem alertar. Puro, sem I/O: serve ao navegador
 * (antes de enviar) e ao servidor (antes de gravar), porque a rota é pública e aceita relato de qualquer cliente.
 *
 * Regra: o stack tem pelo menos um frame com endereço de extensão e NENHUM frame de endereço comum
 * (http/https/blob...). Stack sem endereço nenhum, ou misturado com nosso domínio/_next, continua sendo relatado.
 */
const EXTENSION_SCHEME = /\b(?:chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension):\/\//i;
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi;

export function isBrowserExtensionOnlyStack(stack: string | null | undefined): boolean {
  if (!stack) return false;
  const urls = stack.match(ANY_URL);
  if (!urls || urls.length === 0) return false;
  let hasExtension = false;
  for (const url of urls) {
    if (EXTENSION_SCHEME.test(url)) hasExtension = true;
    else return false;
  }
  return hasExtension;
}
