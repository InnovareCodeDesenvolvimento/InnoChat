"use server";

import { Result, runAction } from "@/lib/result";
import { recordAudit, platformAdminActor } from "@/modules/audit/record";
import { clearSupportCookie, getSupportCookieValue } from "@/modules/support/cookie";
import { closeSupportSession, validateSupportSession } from "@/modules/support/service";

export type ExitSupportOutput = {
  closed: boolean;
  redirectTo: string;
};

/**
 * Server Action para encerrar a sessão de suporte ativa.
 * Lê o cookie, fecha a sessão no banco com motivo EXITED, limpa o cookie e audita o encerramento.
 */
export async function exitSupportAction(): Promise<Result<ExitSupportOutput>> {
  return runAction(async () => {
    const cookieValue = await getSupportCookieValue();
    let tenantIdForRedirect = "";
    let sessionIdToClose: string | null = null;
    let adminUserId: string | null = null;

    if (cookieValue) {
      const validation = await validateSupportSession({ cookieValue });
      if (validation.ok) {
        sessionIdToClose = validation.sessionId;
        tenantIdForRedirect = validation.tenantId;
        adminUserId = validation.adminUserId;
      } else if (validation.tenantId) {
        tenantIdForRedirect = validation.tenantId;
      }
    }

    if (sessionIdToClose) {
      await closeSupportSession({
        sessionId: sessionIdToClose,
        reason: "EXITED",
      });

      if (adminUserId && tenantIdForRedirect) {
        await recordAudit({
          tenantId: tenantIdForRedirect,
          actor: platformAdminActor(adminUserId),
          action: "support.session_closed",
          targetType: "tenant",
          targetId: tenantIdForRedirect,
          summary: "Sessão de suporte encerrada pelo administrador.",
          supportSessionId: sessionIdToClose,
        });
      }
    }

    await clearSupportCookie();

    const redirectTo = tenantIdForRedirect
      ? `/admin/empresas/${tenantIdForRedirect}`
      : "/admin/empresas";

    return {
      closed: Boolean(sessionIdToClose),
      redirectTo,
    };
  });
}
