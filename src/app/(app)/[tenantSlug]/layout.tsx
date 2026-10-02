import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import "@/app/globals.css";
import { fontVariables } from "@/app/fonts";
import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/db/prisma";
import { effectiveStatus } from "@/core/billing";
import { resolveBillingBanner } from "@/components/shell/billing-banner-state";
import { updateBillingContactAction } from "@/modules/billing/contact-actions";
import { ToastProvider } from "@/components/ui/toast";
import { ClientErrorReporter } from "@/components/error-monitor/client-error-reporter";
import { HelpVisibilityProvider } from "@/components/help/help-visibility";
import { NavigationProgress } from "@/components/shell/navigation-progress";
import { PanelShell } from "@/components/shell/panel-shell";
import { getOnboardingStateAction } from "@/modules/onboarding/actions";
import { TwoFactorCard } from "@/components/account/two-factor-card";
import { TwoFactorNudge } from "@/components/account/two-factor-nudge";
import { getTwoFactorStatus } from "@/modules/two-factor/service";

export const metadata: Metadata = { title: "InnoChat · Painel" };

/**
 * Root layout do painel do tenant. Resolve o tema (`Tenant.theme`) e a
 * empresa NO SERVIDOR, antes de mandar HTML para o navegador — por isso
 * `data-theme` já sai certo no primeiro parágrafo de resposta, sem "flash"
 * do tema padrão.
 *
 * Proteção de rota (pedido explícito: "middleware ou layout"): feita aqui,
 * não em `middleware.ts`. Motivo: a checagem real não é só "tem sessão?" —
 * é "esse usuário tem Membership NESSE tenant?", o que exige ler o banco;
 * fazer isso em middleware duplicaria a consulta que o layout já precisa
 * fazer para montar o shell (nome da empresa, tema). Um usuário autenticado
 * sem vínculo com o tenant da URL recebe 404 (nunca 403 — não confirma que o
 * tenant existe para quem não é dele, mesma regra do contrato interno,
 * docs/arquitetura.md §6.1).
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const membership = await getPrisma().membership.findFirst({
    where: { userId: session.user.id, tenant: { slug: tenantSlug } },
    select: {
      role: true,
      tenant: {
        select: { id: true, name: true, theme: true, timezone: true, billingWhatsappE164: true, billingWhatsappOptOutAt: true },
      },
    },
  });

  if (!membership) {
    notFound();
  }

  // Status efetivo da assinatura (docs/arquitetura.md §7.4) para o banner global do painel —
  // sempre calculado sob demanda (`effectiveStatus`, puro), nunca confiando só no `status`
  // persistido (que só o `billing/tick` de hora em hora mantém em dia).
  // Tudo filtrado por `tenantId` explícito (Prisma cru, fora do `forTenant`): a assinatura e as duas
  // faturas que o banner precisa (a aberta mais próxima de vencer e o último pagamento).
  const tenantId = membership.tenant.id;
  const [subscription, openInvoice, lastPaidInvoice] = await Promise.all([
    getPrisma().subscription.findUnique({
      where: { tenantId },
      select: { status: true, trialEndsAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, firstPaidAt: true, manualSuspendedAt: true },
    }),
    getPrisma().invoice.findFirst({
      where: { status: "OPEN", subscription: { tenantId } },
      orderBy: { dueAt: "asc" },
      select: { amountCents: true, dueAt: true },
    }),
    getPrisma().invoice.findFirst({
      where: { status: "PAID", paidAt: { not: null }, subscription: { tenantId } },
      orderBy: { paidAt: "desc" },
      select: { paidAt: true },
    }),
  ]);
  const now = new Date();
  // `timezone` entra no retrato para o vencimento de quem paga valer 23:59 do dia local (core de billing).
  const snapshot = subscription ? { ...subscription, timezone: membership.tenant.timezone } : null;
  const status = snapshot ? effectiveStatus(snapshot, now) : null;
  const billingBanner = snapshot
    ? resolveBillingBanner({ subscription: snapshot, openInvoice, lastPaidAt: lastPaidInvoice?.paidAt ?? null }, now)
    : null;
  // Pedido do WhatsApp de cobrança: só o OWNER, só quem ainda não informou número e não desligou
  // os avisos, e nunca em cima de um aviso vermelho (atrasada, suspensa, cancelada).
  const askBillingPhone =
    membership.role === "OWNER" &&
    !membership.tenant.billingWhatsappE164 &&
    !membership.tenant.billingWhatsappOptOutAt &&
    billingBanner?.kind !== "GRACE" &&
    billingBanner?.kind !== "SUSPENDED" &&
    billingBanner?.kind !== "CANCELED";

  // Onboarding (docs/arquitetura.md §13): incompleto enquanto não houver nenhum serviço OU
  // nenhum profissional com expediente cadastrado — o link "Primeiros passos" some da sidebar
  // assim que os dois existirem (WhatsApp fica de fora da checagem: ainda não tem tela).
  const [serviceCount, professionalWithHoursCount, disconnectedWhatsappCount, connectedWhatsappCount, totalWhatsappCount, sessionUserRecord, onboardingStateResult] =
    await Promise.all([
      getPrisma().service.count({ where: { tenantId: membership.tenant.id } }),
      getPrisma().professional.count({
        where: { tenantId: membership.tenant.id, workingHours: { some: {} } },
      }),
      getPrisma().whatsappInstance.count({
        where: { tenantId: membership.tenant.id, deletedAt: null, status: "DISCONNECTED" },
      }),
      // Chip "ao vivo" da topbar (docs/design/premium-spec.md §1/§10) — dado real, não decoração:
      // ponto verde pulsando só quando existe pelo menos 1 número CONNECTED.
      getPrisma().whatsappInstance.count({
        where: { tenantId: membership.tenant.id, deletedAt: null, status: "CONNECTED" },
      }),
      getPrisma().whatsappInstance.count({
        where: { tenantId: membership.tenant.id, deletedAt: null },
      }),
      // `emailVerifiedAt` nunca vem da sessão (não é lido no `session.user`) — relido aqui, direto
      // do banco, para o banner discreto de "confirme seu e-mail" (mesma regra de
      // `requireVerifiedEmail`, src/lib/auth/guards.ts).
      getPrisma().user.findUnique({
        where: { id: session.user.id },
        select: { emailVerifiedAt: true, name: true, totpEnabledAt: true, twoFactorRequired: true },
      }),
      // Tour guiado do Inno: abre sozinho só no 1º acesso deste usuário (`tourCompletedAt` nulo).
      // Falha ao ler o estado NÃO abre o tour (melhor não mostrar do que repetir a cada página).
      getOnboardingStateAction(tenantSlug),
    ]);
  const tourAutoStart = onboardingStateResult.ok && onboardingStateResult.data.tourCompletedAt === null;
  const onboardingIncomplete = serviceCount === 0 || professionalWithHoursCount === 0;
  // Ponto de alerta discreto na sidebar (mission): só para instância que já esteve conectada e
  // caiu — uma instância recém-criada nasce em `QRCODE` (esperando o primeiro scan), o que NÃO é
  // "queda" e não deveria acender o alerta.
  const whatsappNeedsAttention = disconnectedWhatsappCount > 0;
  const whatsappStatus: "connected" | "disconnected" | "none" =
    connectedWhatsappCount > 0 ? "connected" : totalWhatsappCount > 0 ? "disconnected" : "none";
  const emailVerified = !!sessionUserRecord?.emailVerifiedAt;
  // 2FA: exigida para o usuário (flag individual) e ainda não ligada => só a tela de ativação.
  // Dono sem 2FA (opcional) => convite discreto no topo. O admin da plataforma é barrado em /admin.
  const twoFactorEnabled = !!sessionUserRecord?.totpEnabledAt;
  const twoFactorGate = sessionUserRecord?.twoFactorRequired && !twoFactorEnabled ? await getTwoFactorStatus(session.user.id) : null;
  const showTwoFactorNudge = membership.role === "OWNER" && !twoFactorEnabled && !twoFactorGate;

  return (
    <html lang="pt-BR" data-theme={membership.tenant.theme} className={fontVariables}>
      <body>
        <NavigationProgress />
        <ClientErrorReporter />
        <ToastProvider>
          <HelpVisibilityProvider>
          <PanelShell
            tenantName={membership.tenant.name}
            tenantSlug={tenantSlug}
            timezone={membership.tenant.timezone}
            userEmail={session.user.email ?? ""}
            userName={sessionUserRecord?.name ?? null}
            subscriptionStatus={status}
            billingBanner={billingBanner}
            billingNowMs={now.getTime()}
            askBillingPhone={askBillingPhone}
            saveBillingContact={updateBillingContactAction}
            onboardingIncomplete={onboardingIncomplete}
            whatsappNeedsAttention={whatsappNeedsAttention}
            isOwner={membership.role === "OWNER"}
            whatsappStatus={whatsappStatus}
            emailVerified={emailVerified}
            tourAutoStart={tourAutoStart}
          >
            {twoFactorGate ? (
              <TwoFactorCard status={twoFactorGate} forced />
            ) : (
              <>
                {showTwoFactorNudge ? <TwoFactorNudge href={`/${tenantSlug}/minha-conta`} /> : null}
                {children}
              </>
            )}
          </PanelShell>
          </HelpVisibilityProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
