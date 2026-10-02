/**
 * Estado em memória que PRECISA ser um só por processo, mesmo quando o Next empacota o mesmo módulo em bundles
 * diferentes (Server Action, Route Handler e páginas ganham cópias separadas do módulo no build de produção: um `Map`
 * no topo do arquivo vira vários `Map` independentes).
 *
 * Isso é um problema de SEGURANÇA quando o estado é uma trava: o rate limit contava a metade das tentativas e o desafio de
 * 2º fator de uso único podia ser usado uma vez em cada bundle (a tela de login e `/api/auth/callback/two-factor`).
 * Guardar o estado em `globalThis` por `Symbol.for` (o mesmo padrão de `prisma.ts` e do gancho do `logger`) devolve a
 * MESMA instância a todas as cópias do módulo. Premissa de sempre: um processo só (docs/arquitetura.md §14).
 */
const NAMESPACE = "innochat:state:";

export function globalState<T>(name: string, init: () => T): T {
  const store = globalThis as Record<symbol, unknown>;
  const key = Symbol.for(NAMESPACE + name);
  if (!(key in store)) store[key] = init();
  return store[key] as T;
}
