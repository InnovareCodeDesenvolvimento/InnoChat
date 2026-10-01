/**
 * Detecta `PrismaClientKnownRequestError` com `code === "P2002"` (violação de unique
 * constraint) por assinatura (`constructor.name`), sem `instanceof` de `@prisma/client`
 * (proibido fora de `src/lib/db/`, ver `eslint.config.mjs`) — extraído do padrão antes
 * duplicado em `src/modules/bot-api/claim.ts` e `src/modules/whatsapp/connection.ts`
 * (`.claude/agent-memory/vega/prisma_exclude_violation_shape.md`).
 *
 * Uso típico: dentro de um `try/catch` em volta de um `create()` que corre contra outra
 * transação concorrente para o MESMO registro (dedupe por constraint única é o backstop final
 * contra a corrida) — trata a violação como "já existe/já processado", nunca como erro 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.constructor?.name === "PrismaClientKnownRequestError" && (error as unknown as { code?: string }).code === "P2002";
}

/**
 * `P2028` = a transação interativa estourou o `timeout` (ou já estava fechada). Mesma detecção por
 * nome de classe de `isUniqueViolation` (sem `instanceof` fora de `src/lib/db/`).
 */
export function isTransactionTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.constructor?.name === "PrismaClientKnownRequestError" && (error as unknown as { code?: string }).code === "P2028";
}

export type SafeDbErrorInfo = { errorName: string; code?: string; target?: string };

/**
 * Resumo de um erro para LOG que nunca carrega `error.message`. As mensagens do Prisma (validação
 * e várias violações) reproduzem os ARGUMENTOS da consulta — para gravação de histórico isso é o
 * corpo da mensagem do cliente (LGPD). Só sai o nome da classe, o `code` (ex.: P2003) e o
 * `meta.target`/`meta.field_name` quando forem texto simples de schema.
 */
export function describeDbError(error: unknown): SafeDbErrorInfo {
  if (!(error instanceof Error)) return { errorName: "unknown" };
  const info: SafeDbErrorInfo = { errorName: error.constructor?.name || error.name || "Error" };
  const withCode = error as unknown as { code?: unknown; meta?: { target?: unknown; field_name?: unknown } };
  if (typeof withCode.code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(withCode.code)) info.code = withCode.code;
  const target = withCode.meta?.target ?? withCode.meta?.field_name;
  const asText = Array.isArray(target) ? target.filter((t) => typeof t === "string").join(",") : target;
  if (typeof asText === "string" && /^[A-Za-z0-9_,.\- ]{1,120}$/.test(asText)) info.target = asText;
  return info;
}
