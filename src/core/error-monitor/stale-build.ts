/**
 * Erro de "versão antiga aberta": a pessoa estava com uma página da versão anterior aberta, publicamos uma nova e os
 * arquivos de script daquela versão deixaram de existir. Ao navegar, o navegador pede um pedaço (chunk) que sumiu.
 * Não é defeito do sistema: recarregar a página resolve. Puro, sem I/O: serve ao navegador (recarregar em vez de
 * relatar) e ao servidor (não gravar, porque a rota é pública).
 */
const STALE_BUILD_MESSAGES = [
  /Failed to load chunk/i, // Turbopack
  /Loading chunk [\w-]+ failed/i, // webpack
  /Loading CSS chunk [\w-]+ failed/i,
  /Failed to fetch dynamically imported module/i, // Chrome
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  // Aba aberta antes de uma publicação tenta chamar uma Server Action que só existia no build
  // anterior (o id é um hash do código/rota, muda a cada build). Recarregar busca o bundle novo,
  // que tem o id certo — não é defeito do sistema (relatado pelo dono em produção, 2026-10-19).
  /Failed to find Server Action/i,
];

export function isStaleBuildError(type: string | null | undefined, message: string | null | undefined): boolean {
  if (type === "ChunkLoadError") return true;
  if (!message) return false;
  return STALE_BUILD_MESSAGES.some((re) => re.test(message));
}
