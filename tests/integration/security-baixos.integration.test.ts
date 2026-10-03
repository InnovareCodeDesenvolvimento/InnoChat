/**
 * Correções dos achados BAIXOS das revisões do Órion (v1.7.x), contra Postgres real:
 * B-5 (trocar a chave do backup pede senha ou código), B-6 (falha da auditoria vira alerta) e
 * B-8 (teto de ofertas automáticas da lista de espera por empresa por hora).
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const session: { adminId: string } = { adminId: "" };
vi.mock("@/lib/auth/guards", () => ({
  requirePlatformAdmin: async () => ({ id: session.adminId }),
  requireTenantMember: async () => {
    throw new Error("não usado");
  },
}));

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const userIds: string[] = [];

afterAll(async () => {
  await prisma.providerEvent.deleteMany({ where: { provider: "waitlist-auto-offer", providerEventId: { startsWith: `it-baixos-${run}` } } });
  await prisma.errorGroup.deleteMany({ where: { message: { contains: `it-baixos-${run}` } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});


describe("B-5: trocar a chave do backup exige prova de quem é", () => {
  it("recusa sem senha/código e com senha errada; aceita com a senha certa", async () => {
    const password = "senha-certa-123";
    const admin = await prisma.user.create({
      data: { email: `it-baixos-${run}@example.test`, passwordHash: await bcrypt.hash(password, 4), isPlatformAdmin: true },
    });
    userIds.push(admin.id);
    session.adminId = admin.id;
    const { generateBackupKeyAction } = await import("@/modules/backup/actions");
    const { REPLACE_KEY_CONFIRMATION } = await import("@/modules/backup/policy");
    const { __resetRateLimitsForTests } = await import("@/lib/rate-limit");
    __resetRateLimitsForTests();

    // garante que já existe uma chave (primeira geração não exige prova)
    const config = await prisma.backupConfig.findUnique({ where: { id: 1 } });
    if (!config?.encryptionKeyEnc) {
      const first = await generateBackupKeyAction({});
      expect(first.ok).toBe(true);
    }
    const before = (await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).encryptionKeyFingerprint;

    const semProva = await generateBackupKeyAction({ replace: true, confirmation: REPLACE_KEY_CONFIRMATION });
    expect(semProva.ok).toBe(false);
    const errada = await generateBackupKeyAction({ replace: true, confirmation: REPLACE_KEY_CONFIRMATION, password: "outra-senha" });
    expect(errada.ok).toBe(false);
    expect((await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).encryptionKeyFingerprint).toBe(before);

    const certa = await generateBackupKeyAction({ replace: true, confirmation: REPLACE_KEY_CONFIRMATION, password });
    expect(certa.ok).toBe(true);
    expect((await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } })).encryptionKeyFingerprint).not.toBe(before);
  });
});

describe("B-6: falha ao gravar a auditoria vira erro monitorado", () => {
  it("a ação segue, e o erro entra em Admin > Erros com o código da ação", async () => {
    const { setErrorSink } = await import("@/lib/logger");
    const { captureLoggedError } = await import("@/modules/error-monitor/capture");
    const { recordAudit, SYSTEM_ACTOR } = await import("@/modules/audit/record");
    setErrorSink(captureLoggedError);
    try {
      const action = `it.baixos_${run}`;
      const failing = { auditLog: { create: async () => Promise.reject(new Error("banco fora")) } };
      await expect(recordAudit({ tenantId: null, actor: SYSTEM_ACTOR, action, summary: "x", ip: null }, failing)).resolves.toBeUndefined();

      let group: { message: string } | null = null;
      for (let i = 0; i < 40 && !group; i += 1) {
        group = await prisma.errorGroup.findFirst({ where: { message: { contains: action } }, select: { message: true } });
        if (!group) await new Promise((r) => setTimeout(r, 100));
      }
      expect(group?.message).toContain("audit.record_failed");
      expect(group?.message).toContain(action);
      expect(group?.message).not.toContain("banco fora"); // texto cru do banco não vai para o monitor
      await prisma.errorGroup.deleteMany({ where: { message: { contains: action } } });
    } finally {
      setErrorSink(null);
    }
  });
});

describe("B-8: teto de ofertas automáticas por empresa por hora", () => {
  it("libera só o teto, mesmo com pedidos simultâneos, e a hora seguinte começa do zero", async () => {
    const { takeAutoOfferQuota } = await import("@/modules/waitlist/offer");
    const { WAITLIST_MAX_AUTO_OFFERS_PER_HOUR: cap } = await import("@/core/waitlist/match");
    const tenantId = `it-baixos-${run}-a`;
    // Início de uma hora cheia perto de agora (a faxina apaga linhas com mais de 3 h, então não vale data de outro ano).
    const startOfHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const hour = new Date(startOfHour + 600_000);

    const results = await Promise.all(Array.from({ length: cap + 10 }, () => takeAutoOfferQuota(tenantId, hour)));
    expect(results.filter((r) => r !== null)).toHaveLength(cap);
    expect(await takeAutoOfferQuota(tenantId, new Date(startOfHour + 3_540_000))).toBeNull();
    // outra empresa não é afetada, e a próxima hora cheia libera de novo
    expect(await takeAutoOfferQuota(`it-baixos-${run}-b`, hour)).not.toBeNull();
    expect(await takeAutoOfferQuota(tenantId, new Date(startOfHour + 3_600_000))).not.toBeNull();
  });
});
