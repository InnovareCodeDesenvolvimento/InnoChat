/**
 * Dedup de requisições repetidas (mesmo `clientMessageId` no "Tentar de novo"). Em memória: um único
 * processo Next.js na v1 (mesma premissa de `rate-limit.ts`). Se escalar horizontalmente, isto precisa
 * virar tabela/Redis.
 *
 * - Em andamento: quem repete ESPERA a mesma promessa e recebe a mesma resposta (não roda de novo).
 * - Sucesso: guardado por `ttlMs`; repetição devolve o mesmo valor sem executar.
 * - Erro: NÃO é guardado (a operação não aconteceu; repetir deve poder tentar de novo).
 */

type Entry = { promise: Promise<unknown>; expiresAt: number | null };

const entries = new Map<string, Entry>();
const MAX_ENTRIES = 5000;

function prune(now: number) {
  for (const [key, entry] of entries) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) entries.delete(key);
  }
  // Teto duro: descarta as mais antigas (ordem de inserção do Map) se ainda passar.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export async function runIdempotent<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = entries.get(key);
  if (existing && (existing.expiresAt === null || existing.expiresAt > now)) return existing.promise as Promise<T>;

  prune(now);
  const promise = run();
  const entry: Entry = { promise, expiresAt: null };
  entries.set(key, entry);
  try {
    const value = await promise;
    entry.expiresAt = Date.now() + ttlMs;
    return value;
  } catch (error) {
    if (entries.get(key) === entry) entries.delete(key);
    throw error;
  }
}

/** Só para testes. */
export function __resetIdempotencyForTests() {
  entries.clear();
}
