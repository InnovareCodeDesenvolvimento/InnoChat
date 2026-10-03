import { getPrisma } from "./prisma";

/** Teto de duração do trabalho sob a trava (a transação que a segura fica aberta até lá). */
const LOCK_MAX_MS = 15 * 60 * 1000;

export type AdvisoryLockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Roda `fn` só se conseguir a trava de aplicação `name` (Postgres `pg_try_advisory_xact_lock`).
 * Não esperou: se outro processo/instância já segura a trava, devolve `{ acquired: false }` na hora
 * e `fn` NÃO roda.
 *
 * Por que de TRANSAÇÃO e não de sessão: o Prisma usa pool, e a trava de sessão precisa ser pega e
 * solta na MESMA conexão (sem garantia entre chamadas soltas — acabaria vazando a trava na conexão
 * devolvida ao pool). A trava de transação é solta sozinha no COMMIT/ROLLBACK ou se a conexão cair,
 * então não existe caminho de erro que a deixe presa. A transação só segura a trava (uma consulta);
 * o trabalho de `fn` usa o pool normal.
 *
 * `name` vira o inteiro da trava por `hashtext` (mesmo nome = mesma trava, em qualquer instância).
 */
export async function withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<AdvisoryLockResult<T>> {
  return getPrisma().$transaction(
    async (tx): Promise<AdvisoryLockResult<T>> => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${name}::text)) AS locked`;
      if (!rows[0]?.locked) return { acquired: false };
      return { acquired: true, value: await fn() };
    },
    { maxWait: 10_000, timeout: LOCK_MAX_MS },
  );
}

/**
 * Versão que ESPERA a vez (`pg_advisory_xact_lock`): duas chamadas com o mesmo `name` rodam `fn` uma depois da outra,
 * nunca juntas, em qualquer instância. Serve para "ler, decidir e gravar" sem corrida (ex.: teto por contato). `fn` deve
 * ser curto (algumas consultas): a trava vale até o fim da transação e o tempo total é limitado.
 */
export async function withBlockingAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return getPrisma().$transaction(
    async (tx): Promise<T> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}::text))`;
      return fn();
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
}
