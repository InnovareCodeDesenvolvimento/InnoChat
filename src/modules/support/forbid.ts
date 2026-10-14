import { DomainError } from "@/lib/errors";

export type SupportContext = {
  isSupportImpersonation?: boolean;
  supportSessionId?: string | null;
};

/**
 * Ações proibidas durante uma sessão de suporte (impersonação do admin da plataforma).
 * Definidas na arquitetura e decisão do dono (Onda 1 e Onda 5):
 * - Excluir empresa ou alterar slug
 * - Alterar e-mail, senha ou 2FA do owner
 * - Excluir membros da equipe
 * - Desconectar WhatsApp sem dupla confirmação
 * - Assinatura / Cobrança: cancelar assinatura, trocar plano diretamente
 */
export const FORBIDDEN_SUPPORT_ACTIONS = [
  "tenant.delete",
  "tenant.update_slug",
  "tenant.change_slug",
  "user.change_email",
  "user.change_password",
  "user.change_totp",
  "user.reset_password",
  "membership.delete",
  "membership.remove",
  "whatsapp.disconnect",
  "subscription.cancel",
  "subscription.change_plan",
] as const;

export type ForbiddenSupportAction = (typeof FORBIDDEN_SUPPORT_ACTIONS)[number];

export class SupportForbiddenError extends DomainError {
  constructor(action: string) {
    super(
      "SUPPORT_ACTION_FORBIDDEN",
      `Ação '${action}' não é permitida durante sessão de suporte por motivos de segurança.`
    );
  }
}

/**
 * Lança se a requisição estiver ocorrendo sob impersonação de suporte e a ação estiver na blacklist.
 */
export function forbidDuringSupport(ctx: SupportContext | null | undefined, action: string): void {
  if (!ctx || !ctx.isSupportImpersonation) {
    return;
  }

  const isForbidden = FORBIDDEN_SUPPORT_ACTIONS.includes(action as ForbiddenSupportAction);
  if (isForbidden) {
    throw new SupportForbiddenError(action);
  }
}
