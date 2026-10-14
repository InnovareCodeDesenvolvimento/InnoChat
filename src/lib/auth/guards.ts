import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import type { MembershipRole } from "@/lib/db/types";
import { clearSupportCookie, getSupportCookieValue } from "@/modules/support/cookie";
import { validateSupportSession } from "@/modules/support/service";

export type SessionUser = { id: string };

export type TenantContext = {
  tenant: { id: string; slug: string; name: string; timezone: string };
  membership: { id: string; role: MembershipRole };
  user: SessionUser;
  /** Se o acesso foi concedido via impersonação de suporte por admin da plataforma. */
  isSupportImpersonation?: boolean;
  /** ID da sessão de suporte ativa (tabela `support_sessions`). */
  supportSessionId?: string | null;
};

/**
 * Exige uma sessão válida (Auth.js). Lança `UNAUTHENTICATED` — as Server Actions convertem
 * isso em `Result` de erro (src/lib/result.ts); páginas/layouts que exigem login tratam via
 * `redirect()` antes de chegar aqui (fora do escopo da Vega, ver src/app/**).
 */
export async function requireSessionUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new DomainError("UNAUTHENTICATED", "É necessário estar autenticado.");
  }
  return { id: session.user.id };
}

/**
 * Guarda do admin da plataforma (docs/arquitetura.md §9, "Plataforma"). Nunca confia em nada
 * vindo do client — sempre relê `isPlatformAdmin` (e a 2FA) do banco a partir do id da sessão.
 */
export async function requirePlatformAdmin(): Promise<SessionUser> {
  const sessionUser = await requireSessionUser();
  const user = await getPrisma().user.findUnique({
    where: { id: sessionUser.id },
    select: { id: true, isPlatformAdmin: true, totpEnabledAt: true },
  });
  if (!user?.isPlatformAdmin) {
    throw new DomainError("FORBIDDEN", "Requer acesso de administrador da plataforma.");
  }
  // O layout do /admin só esconde a interface; Server Actions são endpoints POST. Sem 2FA ligada, o
  // admin não opera nada além de ativar a própria 2FA (essas actions usam `requireSessionUser`).
  if (!user.totpEnabledAt) {
    throw new DomainError("TWO_FACTOR_SETUP_REQUIRED", "Ative a verificação em 2 etapas para usar o painel de administração.");
  }
  return { id: user.id };
}

/**
 * Guarda de e-mail verificado (docs/arquitetura.md §7.3 regra 2, Fase 7): "sem e-mail
 * verificado, não é possível conectar WhatsApp" — o resto do painel funciona sem isso. Relê
 * `emailVerifiedAt` do banco (nunca confia em campo de sessão). Quem for implementar a conexão
 * de número (Fase 3) chama isto ANTES de criar/religar uma `WhatsappInstance`.
 */
export async function requireVerifiedEmail(): Promise<SessionUser> {
  const sessionUser = await requireSessionUser();
  const user = await getPrisma().user.findUnique({
    where: { id: sessionUser.id },
    select: { id: true, emailVerifiedAt: true },
  });
  if (!user?.emailVerifiedAt) {
    throw new DomainError("EMAIL_NOT_VERIFIED", "Confirme seu e-mail antes de conectar o WhatsApp.");
  }
  return { id: user.id };
}

/**
 * Guarda de tenant (docs/arquitetura.md §5, §11): resolve o tenant pelo `slug` — nunca por um
 * id vindo do client — e confirma que o usuário da sessão tem `Membership` nele. Se `roles` for
 * passado, também exige que o papel do usuário esteja na lista.
 *
 * Empresa inexistente OU usuário sem membership → o mesmo `NOT_FOUND` (nunca `FORBIDDEN`), pela
 * mesma razão do §6.1 da API interna: não confirmar a existência de uma empresa para quem não é
 * membro dela.
 */
export async function requireTenantMember(slug: string, roles?: MembershipRole[]): Promise<TenantContext> {
  const sessionUser = await requireSessionUser();

  const tenant = await getPrisma().tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, timezone: true },
  });
  if (!tenant) {
    throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
  }

  const membership = await forTenant(tenant.id).membership.findFirst({
    where: { userId: sessionUser.id },
  });
  if (!membership) {
    // Verifica se é impersonação válida de suporte por admin da plataforma
    const supportCookie = await getSupportCookieValue();
    if (supportCookie) {
      const userRecord = await getPrisma().user.findUnique({
        where: { id: sessionUser.id },
        select: { id: true, isPlatformAdmin: true, totpEnabledAt: true },
      });

      if (userRecord?.isPlatformAdmin && userRecord.totpEnabledAt) {
        const supportValidation = await validateSupportSession({ cookieValue: supportCookie });
        if (supportValidation.ok) {
          if (supportValidation.adminUserId === sessionUser.id && supportValidation.tenantSlug === slug) {
            // Concede acesso como impersonador com papel virtual OWNER
            return {
              tenant,
              membership: { id: "support-session", role: "OWNER" },
              user: sessionUser,
              isSupportImpersonation: true,
              supportSessionId: supportValidation.sessionId,
            };
          }
        } else if (supportValidation.reason === "EXPIRED") {
          await clearSupportCookie();
          const targetTenantId = supportValidation.tenantId ?? tenant.id;
          redirect(`/admin/empresas/${targetTenantId}?expirou=1`);
        }
      }
    }

    throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
  }

  // Usuário com exigência individual de 2FA (`twoFactorRequired`) e ainda sem ela ligada: o layout só
  // mostra a tela de ativação, e as actions do painel recusam aqui (não dá para burlar pelo POST).
  const twoFactor = await getPrisma().user.findUnique({
    where: { id: sessionUser.id },
    select: { twoFactorRequired: true, totpEnabledAt: true },
  });
  if (twoFactor?.twoFactorRequired && !twoFactor.totpEnabledAt) {
    throw new DomainError("TWO_FACTOR_SETUP_REQUIRED", "Ative a verificação em 2 etapas para continuar usando o painel.");
  }

  if (roles && roles.length > 0 && !roles.includes(membership.role)) {
    throw new DomainError("FORBIDDEN", "Sem permissão para esta ação.");
  }

  return {
    tenant,
    membership: { id: membership.id, role: membership.role },
    user: sessionUser,
  };
}
