import { describe, expect, it } from "vitest";
import type { RestoreLock } from "@/lib/db/types";
import {
  acquireRestoreLock,
  getOrCreateRestoreLock,
  releaseRestoreLock,
  setRestoreLockSafetyDump,
  type RestoreLockClient,
} from "./restore-lock";

/**
 * Cria um mock in-memory fiel à semântica do PrismaClient para a tabela restore_locks (singleton id = 1).
 */
function createMockPrisma(initialLock?: Partial<RestoreLock>): {
  prisma: RestoreLockClient;
  getState: () => RestoreLock;
} {
  let state: RestoreLock = {
    id: 1,
    status: "IDLE",
    lockedBy: null,
    lockedAt: null,
    safetyDumpPath: null,
    updatedAt: new Date("2026-10-18T10:00:00.000Z"),
    ...initialLock,
  };

  const prisma: RestoreLockClient = {
    restoreLock: {
      upsert: async ({ create }: { create: Partial<RestoreLock> }) => {
        if (!state) {
          state = {
            id: 1,
            status: create.status ?? "IDLE",
            lockedBy: create.lockedBy ?? null,
            lockedAt: create.lockedAt ? new Date(create.lockedAt) : null,
            safetyDumpPath: create.safetyDumpPath ?? null,
            updatedAt: new Date(),
          };
        }
        return { ...state };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where?: { id?: number; status?: string; lockedBy?: string };
        data: Partial<RestoreLock>;
      }) => {
        let matches = true;

        if (where?.id !== undefined && state.id !== where.id) {
          matches = false;
        }
        if (where?.status !== undefined && state.status !== where.status) {
          matches = false;
        }
        if (where?.lockedBy !== undefined && state.lockedBy !== where.lockedBy) {
          matches = false;
        }

        if (matches) {
          state = {
            ...state,
            status: (data.status as RestoreLock["status"]) ?? state.status,
            lockedBy:
              data.lockedBy === null
                ? null
                : (data.lockedBy as string) ?? state.lockedBy,
            lockedAt:
              data.lockedAt === null
                ? null
                : (data.lockedAt as Date) ?? state.lockedAt,
            safetyDumpPath:
              data.safetyDumpPath === null
                ? null
                : (data.safetyDumpPath as string) ?? state.safetyDumpPath,
            updatedAt: new Date(),
          };
          return { count: 1 };
        }

        return { count: 0 };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => {
        if (state.id !== where.id) {
          throw new Error("Record not found");
        }
        return { ...state };
      },
    } as unknown as RestoreLockClient["restoreLock"],
  };

  return { prisma, getState: () => ({ ...state }) };
}

describe("RestoreLock", () => {
  it("getOrCreateRestoreLock cria ou retorna o singleton id=1 com status IDLE", async () => {
    const { prisma } = createMockPrisma();
    const lock = await getOrCreateRestoreLock(prisma);

    expect(lock.id).toBe(1);
    expect(lock.status).toBe("IDLE");
    expect(lock.lockedBy).toBeNull();
  });

  it("acquireRestoreLock quando status é IDLE: adquire o lock com sucesso", async () => {
    const { prisma, getState } = createMockPrisma({ status: "IDLE" });

    const result = await acquireRestoreLock(prisma, "admin-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lock.status).toBe("RESTORING");
      expect(result.lock.lockedBy).toBe("admin-1");
      expect(result.lock.lockedAt).toBeInstanceOf(Date);
    }

    const state = getState();
    expect(state.status).toBe("RESTORING");
    expect(state.lockedBy).toBe("admin-1");
  });

  it("acquireRestoreLock quando já está RESTORING por outro admin: falha e devolve currentLock", async () => {
    const lockedAt = new Date("2026-10-18T12:00:00.000Z");
    const { prisma, getState } = createMockPrisma({
      status: "RESTORING",
      lockedBy: "admin-1",
      lockedAt,
    });

    const result = await acquireRestoreLock(prisma, "admin-2");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.currentLock.status).toBe("RESTORING");
      expect(result.currentLock.lockedBy).toBe("admin-1");
    }

    // O estado permanece inalterado pelo admin-1
    const state = getState();
    expect(state.lockedBy).toBe("admin-1");
  });

  it("releaseRestoreLock pelo próprio dono do lock: libera com sucesso para IDLE", async () => {
    const { prisma, getState } = createMockPrisma({
      status: "RESTORING",
      lockedBy: "admin-1",
      lockedAt: new Date(),
      safetyDumpPath: "/tmp/safety.dump",
    });

    const result = await releaseRestoreLock(prisma, "admin-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lock.status).toBe("IDLE");
      expect(result.lock.lockedBy).toBeNull();
      expect(result.lock.lockedAt).toBeNull();
      expect(result.lock.safetyDumpPath).toBeNull();
    }

    const state = getState();
    expect(state.status).toBe("IDLE");
    expect(state.lockedBy).toBeNull();
  });

  it("releaseRestoreLock por outro usuário: não libera (retorna success: false)", async () => {
    const { prisma, getState } = createMockPrisma({
      status: "RESTORING",
      lockedBy: "admin-1",
      lockedAt: new Date(),
    });

    const result = await releaseRestoreLock(prisma, "admin-impostor");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.currentLock.status).toBe("RESTORING");
      expect(result.currentLock.lockedBy).toBe("admin-1");
    }

    const state = getState();
    expect(state.status).toBe("RESTORING");
    expect(state.lockedBy).toBe("admin-1");
  });

  it("setRestoreLockSafetyDump salva o safety dump quando chamado pelo dono do lock", async () => {
    const { prisma } = createMockPrisma({
      status: "RESTORING",
      lockedBy: "admin-1",
      lockedAt: new Date(),
    });

    const result = await setRestoreLockSafetyDump(
      prisma,
      "admin-1",
      "/backups/pre-restore-safety.dump",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lock.safetyDumpPath).toBe("/backups/pre-restore-safety.dump");
    }
  });

  it("setRestoreLockSafetyDump rejeita se chamado por usuário diferente do dono", async () => {
    const { prisma } = createMockPrisma({
      status: "RESTORING",
      lockedBy: "admin-1",
      lockedAt: new Date(),
    });

    const result = await setRestoreLockSafetyDump(
      prisma,
      "admin-outro",
      "/backups/pre-restore-safety.dump",
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("NOT_LOCKED_BY_USER");
    }
  });
});
