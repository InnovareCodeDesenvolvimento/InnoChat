import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Renovar o `sv` do JWT da sessão ATUAL depois de incrementar `User.sessionVersion` de propósito (ex.: ao ativar a 2FA,
 * que derruba as OUTRAS sessões mas não a de quem acabou de ativar).
 *
 * Por que não aceitar `trigger: "update"` do Auth.js sem mais nada: o endpoint de sessão também recebe `update` do
 * navegador, e um token já revogado se "ressuscitaria" por ele. Aqui a renovação só vale dentro do escopo assíncrono
 * aberto por `runWithSessionRefresh` (a chamada `unstable_update` feita pela nossa própria Server Action, depois de
 * `requireSessionUser`): outra requisição, em outro contexto, nunca enxerga a permissão.
 */
const scope = new AsyncLocalStorage<{ userId: string }>();

export function runWithSessionRefresh<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ userId }, fn);
}

export function isSessionRefreshAllowed(userId: string): boolean {
  return scope.getStore()?.userId === userId;
}
