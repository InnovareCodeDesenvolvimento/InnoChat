import { getPrisma } from "@/lib/db/prisma";
import { globalState } from "@/lib/global-state";

/**
 * Revogação de sessão JWT — `User.sessionVersion`.
 *
 * A sessão do Auth.js é um JWT sem estado no servidor: sem isto, uma sessão já aberta continua
 * valendo depois de o dono legítimo vincular o Google ou redefinir a senha (o atacante que abriu
 * sessão com uma conta pré-cadastrada não seria derrubado). O JWT carrega `sv` (a versão no
 * momento do login); `src/lib/auth.ts` (callback `jwt`) compara com o banco a cada leitura de
 * sessão e invalida se forem diferentes.
 *
 * CUSTO: 1 SELECT por leitura de sessão seria caro (várias `auth()` por página). Por isso a versão
 * fica em cache de memória por `SESSION_VERSION_CACHE_TTL_MS` (5 s). Consequência assumida: em
 * outra instância do app, uma revogação leva até 5 s para valer; na instância que revogou vale na
 * hora (`forgetSessionVersion`). O login (jwt com `user`/`account`) sempre lê fresco.
 *
 * QUEM INCREMENTA (sempre no MESMO `update` que muda a credencial, para não haver janela):
 * vínculo Google por e-mail em conta não verificada (`resolveGoogleSignIn`, `acceptInviteWithGoogle`),
 * `resetPassword`, e `signOutEverywhere` (ainda sem tela).
 */

export const SESSION_VERSION_CACHE_TTL_MS = 5_000;
const CACHE_MAX_ENTRIES = 5_000;

// Em `globalThis`: sem isto cada bundle (página, Server Action, rota) tem o PRÓPRIO cache e a revogação de sessão feita em um
// deles só chega nos outros quando o TTL de 5 s vence (ver `src/lib/global-state.ts`).
const cache = globalState("session-version-cache", () => new Map<string, { version: number; at: number }>());

/** Versão atual da sessão do usuário; `null` se o usuário não existe mais (sessão deve cair). */
export async function readSessionVersion(userId: string, options: { fresh?: boolean; nowMs?: number } = {}): Promise<number | null> {
  const now = options.nowMs ?? Date.now();
  if (!options.fresh) {
    const hit = cache.get(userId);
    if (hit && now - hit.at < SESSION_VERSION_CACHE_TTL_MS) return hit.version;
  }
  const user = await getPrisma().user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
  if (!user) {
    cache.delete(userId);
    return null;
  }
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(userId, { version: user.sessionVersion, at: now });
  return user.sessionVersion;
}

/** Esquece o cache local — chamar depois de incrementar `sessionVersion`. */
export function forgetSessionVersion(userId: string): void {
  cache.delete(userId);
}

/** Só para testes. */
export function clearSessionVersionCache(): void {
  cache.clear();
}

/** "Sair de todos os dispositivos": invalida toda sessão JWT aberta deste usuário. */
export async function signOutEverywhere(userId: string): Promise<void> {
  await getPrisma().user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
  forgetSessionVersion(userId);
}

/**
 * Decisão pura usada pelo callback `jwt`. Token emitido antes deste recurso não tem `sv`: conta
 * como 0 (não desloga todo mundo no deploy).
 */
export function isSessionVersionCurrent(tokenVersion: unknown, current: number): boolean {
  const sv = typeof tokenVersion === "number" ? tokenVersion : 0;
  return sv === current;
}
