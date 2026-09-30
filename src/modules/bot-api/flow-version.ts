/**
 * Versão do fluxo do bot que está chamando a API interna (docs/bot-v2-plano.md §3.4).
 *
 * O workflow v2 envia `X-InnoChat-Flow: 2` em TODOS os nós HTTP do painel. Sem o header (ou com
 * qualquer outro valor) é o v1 — assim o fluxo antigo continua se comportando exatamente como
 * antes, e só o v2 recebe regras novas (ex.: limite de agendamentos futuros por contato).
 */
export type FlowVersion = 1 | 2;

export const FLOW_VERSION_HEADER = "x-innochat-flow";

export function flowVersionOf(req: Request): FlowVersion {
  return req.headers.get(FLOW_VERSION_HEADER)?.trim() === "2" ? 2 : 1;
}
