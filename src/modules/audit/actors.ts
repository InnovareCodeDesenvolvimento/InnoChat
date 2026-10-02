import { getPrisma } from "@/lib/db/prisma";
import type { AuditActor } from "./record";

/**
 * Ator e empresa de uma ação que é da PESSOA (2FA, por exemplo), não de uma empresa em particular. Admin da
 * plataforma entra sem empresa. Quem tem vínculo com uma empresa só fica ligado a ela quando é UMA; quem trabalha em
 * várias fica sem empresa (o registro aparece só no Admin), porque não dá para saber qual delas "dona" do registro.
 */
export async function auditContextForUser(userId: string): Promise<{ tenantId: string | null; actor: AuditActor }> {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { isPlatformAdmin: true, memberships: { select: { tenantId: true, role: true }, take: 2 } },
  });
  if (!user || user.isPlatformAdmin) return { tenantId: null, actor: { userId, role: "PLATFORM_ADMIN" } };
  if (user.memberships.length === 1) {
    const only = user.memberships[0]!;
    return { tenantId: only.tenantId, actor: { userId, role: only.role === "OWNER" ? "OWNER" : "STAFF" } };
  }
  return { tenantId: null, actor: { userId, role: "OWNER" } };
}
