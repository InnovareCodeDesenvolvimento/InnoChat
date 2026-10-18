import { globalState } from "@/lib/global-state";
import type { ListRemoteBackupsResult } from "./restore-types";

/**
 * Cache em memória da listagem de backups remotos (Drive/S3) — Onda 1 do Restore.
 *
 * Achado do Órion: a tela de Restore batia no Drive/S3 a cada F5/paginação e gravava
 * audit log ("backup.remote_listed") a cada carregamento. Isso gera custo de API e ruído
 * de auditoria sem valor (a lista de backups muda, no máximo, a cada execução do backup
 * diário/manual — nunca a cada clique do admin).
 *
 * `globalState` é obrigatório aqui: um `Map` solto no topo do módulo vira cópia por bundle
 * no build de produção (Server Action x Route Handler), ver módulo [[module_state_duplicated_across_next_bundles]].
 */

const CACHE_TTL_MS = 30_000;
const AUDIT_THROTTLE_MS = 5 * 60_000;

type CacheEntry = { result: ListRemoteBackupsResult; expiresAt: number };

function cacheStore(): Map<string, CacheEntry> {
  return globalState<Map<string, CacheEntry>>("backup:remote-list:cache", () => new Map());
}

function auditTimestamps(): Map<string, number> {
  return globalState<Map<string, number>>("backup:remote-list:audit", () => new Map());
}

/** Chave do cache: destino + página + tamanho da página (cada combinação é um resultado distinto). */
export function remoteListCacheKey(destination: string, page: number, pageSize: number): string {
  return `${destination}:${page}:${pageSize}`;
}

export function getCachedRemoteList(key: string, now: number = Date.now()): ListRemoteBackupsResult | null {
  const entry = cacheStore().get(key);
  if (!entry || entry.expiresAt <= now) return null;
  return entry.result;
}

export function setCachedRemoteList(key: string, result: ListRemoteBackupsResult, now: number = Date.now()): void {
  cacheStore().set(key, { result, expiresAt: now + CACHE_TTL_MS });
}

/** Chamado quando um backup novo é gerado (`runBackup`): a lista remota mudou, o cache antigo mentiria. */
export function invalidateRemoteBackupsCache(): void {
  cacheStore().clear();
}

/**
 * Decide se esta listagem deve gerar audit log.
 * - Buscou de verdade no Drive/S3 (não veio do cache): audita sempre e reinicia o relógio do throttle.
 * - Veio do cache: só audita de novo se o último audit real deste admin já passou de 5 min
 *   (ex.: ele ficou minutos na tela sem ação, mas ainda está consultando).
 */
export function shouldAuditRemoteListing(adminId: string, servedFromCache: boolean, now: number = Date.now()): boolean {
  const timestamps = auditTimestamps();
  if (!servedFromCache) {
    timestamps.set(adminId, now);
    return true;
  }
  const last = timestamps.get(adminId);
  if (last !== undefined && now - last < AUDIT_THROTTLE_MS) return false;
  timestamps.set(adminId, now);
  return true;
}
