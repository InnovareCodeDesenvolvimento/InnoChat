import { getPrisma } from "@/lib/db/prisma";
import { AUDIT_RETENTION_DAYS } from "./queries";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Apaga do registro de auditoria o que passou do prazo de guarda (`AUDIT_RETENTION_DAYS`, 5 anos por decisão do dono).
 * Chamado pela manutenção diária. Com o prazo em `null`, não apaga nada. Devolve quantas linhas saíram.
 */
export async function purgeOldAuditLogs(now: Date = new Date()): Promise<number> {
  if (AUDIT_RETENTION_DAYS === null) return 0;
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS);
  const result = await getPrisma().auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
