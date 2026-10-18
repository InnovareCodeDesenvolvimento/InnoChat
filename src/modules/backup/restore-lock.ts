import type { RawPrismaClient } from "@/lib/db/prisma";
import type { RestoreLock } from "@/lib/db/types";

/**
 * Interface mínima do client Prisma necessário para as operações do RestoreLock.
 * Permite passar PrismaClient ou qualquer subset mockado em testes unitários.
 */
export type RestoreLockClient = Pick<RawPrismaClient, "restoreLock">;

export type AcquireLockResult =
  | { success: true; lock: RestoreLock }
  | { success: false; currentLock: RestoreLock };

export type ReleaseLockResult =
  | { success: true; lock: RestoreLock }
  | { success: false; currentLock: RestoreLock };

export type SetSafetyDumpResult =
  | { success: true; lock: RestoreLock }
  | { success: false; reason: "NOT_LOCKED_BY_USER" };

/**
 * Obtém o registro singleton (id = 1) do RestoreLock ou cria um se ainda não existir.
 * Garante que o registro esteja presente e com status default IDLE.
 */
export async function getOrCreateRestoreLock(
  prisma: RestoreLockClient,
): Promise<RestoreLock> {
  return prisma.restoreLock.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      status: "IDLE",
    },
  });
}

/**
 * Tenta adquirir atomicamente o lock de restore para o usuário especificado.
 *
 * Utiliza updateMany condicional: status precisa estar IDLE.
 * Se count === 1: sucesso, lock concedido.
 * Se count === 0: falha, alguém já detém o lock ou está em processo.
 */
export async function acquireRestoreLock(
  prisma: RestoreLockClient,
  userId: string,
): Promise<AcquireLockResult> {
  if (!userId || typeof userId !== "string") {
    throw new Error("acquireRestoreLock exige um userId válido.");
  }

  // Assegura que o registro singleton existe antes de atualizar
  await getOrCreateRestoreLock(prisma);

  const now = new Date();
  const updateResult = await prisma.restoreLock.updateMany({
    where: {
      id: 1,
      status: "IDLE",
    },
    data: {
      status: "RESTORING",
      lockedBy: userId,
      lockedAt: now,
      safetyDumpPath: null,
    },
  });

  const current = await prisma.restoreLock.findUniqueOrThrow({
    where: { id: 1 },
  });

  if (updateResult.count === 1) {
    return { success: true, lock: current };
  }

  return { success: false, currentLock: current };
}

/**
 * Libera o lock de restore se e somente se o solicitante for o detentor atual do lock.
 *
 * Utiliza updateMany condicional por id=1 AND lockedBy=userId.
 * Se count === 1: liberado com sucesso, volta para IDLE e limpa metadados.
 * Se count === 0: não liberado (usuário não possui o lock ou já está IDLE).
 */
export async function releaseRestoreLock(
  prisma: RestoreLockClient,
  userId: string,
): Promise<ReleaseLockResult> {
  if (!userId || typeof userId !== "string") {
    throw new Error("releaseRestoreLock exige um userId válido.");
  }

  const updateResult = await prisma.restoreLock.updateMany({
    where: {
      id: 1,
      lockedBy: userId,
    },
    data: {
      status: "IDLE",
      lockedBy: null,
      lockedAt: null,
      safetyDumpPath: null,
    },
  });

  const current = await prisma.restoreLock.findUniqueOrThrow({
    where: { id: 1 },
  });

  if (updateResult.count === 1) {
    return { success: true, lock: current };
  }

  return { success: false, currentLock: current };
}

/**
 * Salva o caminho do safety dump preliminar (gerado pela Onda 3 antes do pg_restore),
 * desde que o lock ainda pertença ao mesmo admin.
 */
export async function setRestoreLockSafetyDump(
  prisma: RestoreLockClient,
  userId: string,
  safetyDumpPath: string,
): Promise<SetSafetyDumpResult> {
  const updateResult = await prisma.restoreLock.updateMany({
    where: {
      id: 1,
      lockedBy: userId,
      status: "RESTORING",
    },
    data: {
      safetyDumpPath,
    },
  });

  if (updateResult.count === 0) {
    return { success: false, reason: "NOT_LOCKED_BY_USER" };
  }

  const lock = await prisma.restoreLock.findUniqueOrThrow({
    where: { id: 1 },
  });

  return { success: true, lock };
}
