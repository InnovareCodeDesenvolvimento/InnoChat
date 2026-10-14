"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { Result, runAction } from "@/lib/result";
import { recordAudit, platformAdminActor } from "@/modules/audit/record";
import { setSupportCookie } from "@/modules/support/cookie";
import { startSupportSession } from "@/modules/support/service";

const startSupportSchema = z.object({
  tenantId: z.string().min(1, "ID da empresa é obrigatório."),
  reason: z
    .string()
    .trim()
    .min(15, "O motivo deve conter no mínimo 15 caracteres explicando o atendimento.")
    .max(500, "O motivo pode ter no máximo 500 caracteres."),
});

export type StartSupportInput = z.infer<typeof startSupportSchema>;

export type StartSupportOutput = {
  redirectTo: string;
  sessionId: string;
};

/**
 * Server Action para iniciar sessão de suporte / impersonação por administrador da plataforma.
 * Exige requirePlatformAdmin no topo, valida entrada com Zod, cria a sessão no banco,
 * seta o cookie httpOnly e audita o início da sessão.
 */
export async function startSupportAction(input: StartSupportInput): Promise<Result<StartSupportOutput>> {
  return runAction(async () => {
    const adminUser = await requirePlatformAdmin();
    const parsed = startSupportSchema.parse(input);

    const sessionResult = await startSupportSession({
      adminUserId: adminUser.id,
      tenantId: parsed.tenantId,
      reason: parsed.reason,
      ip: null,
      userAgent: null,
    });

    await setSupportCookie(sessionResult.cookieValue);

    await recordAudit({
      tenantId: parsed.tenantId,
      actor: platformAdminActor(adminUser.id),
      action: "support.session_started",
      targetType: "tenant",
      targetId: parsed.tenantId,
      summary: `Sessão de suporte iniciada pelo administrador da plataforma. Motivo: ${parsed.reason.slice(0, 100)}`,
      supportSessionId: sessionResult.sessionId,
    });

    return {
      redirectTo: `/${sessionResult.tenantSlug}/inicio`,
      sessionId: sessionResult.sessionId,
    };
  });
}
