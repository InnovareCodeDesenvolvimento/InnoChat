import { getPrisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/db/types";
import { clientIp } from "@/lib/http/client-ip";
import { logger } from "@/lib/logger";
import { clampText, MAX_ACTION_CHARS, MAX_SUMMARY_CHARS, sanitizeChanges, truncateIp, type AuditChanges } from "./sanitize";

export type AuditActorRole = "OWNER" | "STAFF" | "PLATFORM_ADMIN" | "SYSTEM";

export type AuditActor = { userId: string | null; role: AuditActorRole };

export type AuditInput = {
  /** `null` = ação da plataforma (sem empresa). */
  tenantId: string | null;
  actor: AuditActor;
  /** Código estável no formato `area.acao`, ex.: `service.price_changed`. Os rótulos em português ficam em labels.ts. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Frase curta e legível, sem segredo (até 300 caracteres). */
  summary: string;
  /** De/para só dos campos que mudaram. Segredos são redigidos aqui, mas prefira nem passar o valor. */
  changes?: AuditChanges | null;
  /** Normalmente omitido: lido do pedido atual (Server Action/rota) e truncado. Passe `null` em tarefas sem pedido. */
  ip?: string | null;
};

/** Qualquer coisa com `auditLog.create`: o client global ou o `tx` de uma transação já aberta. */
export type AuditDb = { auditLog: { create: (args: { data: Prisma.AuditLogUncheckedCreateInput }) => Promise<unknown> } };

async function resolveIp(explicit: string | null | undefined): Promise<string | null> {
  if (explicit !== undefined) return truncateIp(explicit);
  try {
    const ip = await clientIp();
    return truncateIp(ip === "unknown" ? null : ip);
  } catch {
    // Fora de um pedido (tick, job, teste): sem IP, e tudo bem.
    return null;
  }
}

/**
 * Registra uma linha no histórico de alterações. NUNCA derruba a ação principal: qualquer falha vira log de erro e
 * a função devolve normalmente. Chame DEPOIS de a mudança ter dado certo (na camada da Server Action ou do serviço).
 * Se a ação já roda dentro de uma transação, passe o `tx` em `db` para a linha nascer e morrer junto com ela; nesse
 * caso um erro de banco aborta a transação inteira, o que é raro porque tudo é saneado antes (tamanhos e segredos).
 */
export async function recordAudit(input: AuditInput, db?: AuditDb): Promise<void> {
  try {
    const changes = sanitizeChanges(input.changes);
    const data: Prisma.AuditLogUncheckedCreateInput = {
      tenantId: input.tenantId,
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      action: clampText(input.action, MAX_ACTION_CHARS) || "unknown",
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      summary: clampText(input.summary, MAX_SUMMARY_CHARS) || "Alteração registrada.",
      ipTruncated: await resolveIp(input.ip),
      ...(changes ? { changes: changes as unknown as Prisma.InputJsonValue } : {}),
    };
    const target = db ?? (getPrisma() as unknown as AuditDb);
    await target.auditLog.create({ data });
  } catch (error) {
    logger.error("audit.record_failed", {
      action: input.action,
      tenantId: input.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Ator de uma ação feita por membro da empresa (papel vem do `Membership` já validado pelo guard). */
export function memberActor(ctx: { user: { id: string }; membership: { role: "OWNER" | "STAFF" } }): AuditActor {
  return { userId: ctx.user.id, role: ctx.membership.role };
}

export function platformAdminActor(userId: string): AuditActor {
  return { userId, role: "PLATFORM_ADMIN" };
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, role: "SYSTEM" };
