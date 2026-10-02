/**
 * Retenção do registro de auditoria (decisão do dono, 2026-10-02): 5 anos. O que passou do prazo sai; o resto fica.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { AUDIT_RETENTION_DAYS } from "@/modules/audit/queries";
import { purgeOldAuditLogs } from "@/modules/audit/retention";

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: `test.retention.${run}` } } });
});

describe("retenção da auditoria", () => {
  it("guarda 5 anos e apaga só o que passou disso", async () => {
    expect(AUDIT_RETENTION_DAYS).toBeGreaterThanOrEqual(5 * 365);
    const now = new Date();
    const base = { actorRole: "SYSTEM", summary: "teste de retenção" } as const;
    await prisma.auditLog.createMany({
      data: [
        { ...base, action: `test.retention.${run}.old`, createdAt: new Date(now.getTime() - (AUDIT_RETENTION_DAYS! + 2) * DAY_MS) },
        { ...base, action: `test.retention.${run}.recent`, createdAt: new Date(now.getTime() - 4 * 365 * DAY_MS) },
      ],
    });

    const removed = await purgeOldAuditLogs(now);

    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await prisma.auditLog.findMany({ where: { action: { startsWith: `test.retention.${run}` } }, select: { action: true } });
    expect(left.map((r) => r.action)).toEqual([`test.retention.${run}.recent`]);
  });
});
