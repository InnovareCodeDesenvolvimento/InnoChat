import { Mail } from "lucide-react";
import { TenantSidebarNav } from "./sidebar-nav";
import { MobileNav } from "./mobile-nav";
import { UserBlock } from "./user-block";
import { TenantSectionLabel } from "./section-label";
import { BackgroundGlow } from "./background-glow";
import { CommandPalette } from "./command-palette";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { NotificationCenterProvider } from "@/components/notifications/notification-center-provider";
import { WhatsappStatusChip, type WhatsappTopbarStatus } from "./whatsapp-status-chip";
import { PageTransition } from "./page-transition";
import { CanceledGate } from "./canceled-gate";
import { OnboardingTourProvider, TourReplayButton } from "@/components/onboarding/onboarding-tour";
import { InnovareCodeBadge } from "@/components/brand/innovarecode-badge";
import { ResendVerificationButton } from "@/components/account/resend-verification-button";
import type { SaveBillingContact } from "@/components/billing/billing-contact-types";
import { SubscriptionBanner } from "./subscription-banner";
import { BillingPhonePrompt } from "./billing-phone-prompt";
import { BillingWhatsappProblemBanner } from "./billing-whatsapp-problem-banner";
import type { BillingBannerState } from "./billing-banner-state";

type SubscriptionStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED" | null;

type PanelShellProps = {
  tenantName: string;
  tenantSlug: string;
  /** Fuso da empresa — agrupa notificações por dia (Hoje/Ontem) no horário certo. */
  timezone?: string;
  userEmail: string;
  /** Nome de exibição (`User.name`); null = ainda sem nome (o bloco mostra o e-mail). */
  userName?: string | null;
  subscriptionStatus?: SubscriptionStatus;
  /** Estado do banner de cobrança, já resolvido no servidor (`resolveBillingBanner`). */
  billingBanner?: BillingBannerState | null;
  /** Instante (ms) em que o servidor calculou `billingBanner`: ponto de partida do contador. */
  billingNowMs?: number;
  /** OWNER sem WhatsApp de cobrança cadastrado: mostra o pedido discreto do número. */
  askBillingPhone?: boolean;
  saveBillingContact?: SaveBillingContact;
  /** OWNER cujo WhatsApp de cobrança falhou nos envios: mostra o aviso com o botão de corrigir. */
  billingWhatsappProblem?: { phoneDisplay: string } | null;
  onboardingIncomplete?: boolean;
  whatsappNeedsAttention?: boolean;
  /** Papel do usuário: STAFF não vê itens só do dono no menu. */
  isOwner?: boolean;
  /** Status simples, já resolvido pelo servidor (`layout.tsx`) para o chip "ao vivo" da topbar —
   * ver docs/design/premium-spec.md §1/§10. Nunca calculado aqui: este componente só desenha. */
  whatsappStatus?: WhatsappTopbarStatus;
  /** `User.emailVerifiedAt` do dono da sessão, já resolvido como booleano pelo layout do tenant
   * (nunca lido daqui — o layout relê do banco, mesma regra de `requireVerifiedEmail`). */
  emailVerified?: boolean;
  /** 1º acesso deste usuário (`tourCompletedAt` nulo): o tour do Inno abre sozinho. */
  tourAutoStart?: boolean;
  children: React.ReactNode;
};

/**
 * Banner discreto — não bloqueia nada, só lembra (o resto do painel funciona sem o e-mail
 * confirmado; só conectar WhatsApp exige, `requireVerifiedEmail`). Some assim que
 * `emailVerified` virar `true` numa navegação seguinte (o layout relê do banco a cada request).
 */
function EmailVerificationBanner() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg px-4 py-2 text-sm sm:px-6">
      <span className="flex items-center gap-2 text-text-secondary">
        <Mail className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        Confirme seu e-mail para poder conectar um número de WhatsApp.
      </span>
      <ResendVerificationButton variant="ghost" size="sm" />
    </div>
  );
}

function Brand({ tenantName }: { tenantName: string }) {
  const initials = tenantName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-card bg-gradient-to-br from-primary to-primary-strong font-display text-sm font-bold text-white shadow-card">
        {initials || "IC"}
      </div>
      <span className="truncate font-display text-sm font-bold text-sidebar-text">{tenantName}</span>
    </div>
  );
}

/**
 * Shell do painel do tenant (docs/design/premium-spec.md §1/§2/§3/§11): sidebar em gradiente com
 * navegação agrupada colapsável, topbar com vidro (`backdrop-blur-2xl`) + paleta de comando
 * (Ctrl+K) + chip de status do WhatsApp, brilho de fundo sutil, transição entre páginas. Gaveta
 * com hambúrguer no celular. Todo o conteúdo real das páginas vem em `children`.
 */
export function PanelShell({
  tenantName,
  tenantSlug,
  timezone = "America/Sao_Paulo",
  userEmail,
  userName = null,
  subscriptionStatus = null,
  billingBanner = null,
  billingNowMs = 0,
  askBillingPhone = false,
  saveBillingContact,
  billingWhatsappProblem = null,
  onboardingIncomplete = false,
  whatsappNeedsAttention = false,
  isOwner = true,
  whatsappStatus = "none",
  emailVerified = true,
  tourAutoStart = false,
  children,
}: PanelShellProps) {
  // Assinatura cancelada: o painel mostra só a tela de Assinatura (sidebar enxuta + `CanceledGate`).
  const billingOnly = subscriptionStatus === "CANCELED";
  return (
    <OnboardingTourProvider tenantSlug={tenantSlug} autoStart={tourAutoStart}>
    <NotificationCenterProvider tenantSlug={tenantSlug}>
    <div className="relative flex min-h-screen">
      <BackgroundGlow />
      <aside data-tour="sidebar" className="relative z-10 hidden w-64 shrink-0 flex-col panel-sidebar-surface px-4 py-6 lg:sticky! lg:top-0 lg:flex lg:h-screen lg:self-start">
        <div className="mb-8 px-2">
          <Brand tenantName={tenantName} />
        </div>
        <div className="flex-1 overflow-y-auto">
          <TenantSidebarNav
            tenantSlug={tenantSlug}
            onboardingIncomplete={onboardingIncomplete}
            whatsappNeedsAttention={whatsappNeedsAttention}
            isOwner={isOwner}
            billingOnly={billingOnly}
          />
        </div>
        <div className="mt-4 border-t border-white/10 pt-4">
          <UserBlock userEmail={userEmail} userName={userName} accountHref={`/${tenantSlug}/minha-conta`} />
          <TourReplayButton />
        </div>
      </aside>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border bg-surface/70 px-4 backdrop-blur-2xl sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <MobileNav
              variant="tenant"
              tenantSlug={tenantSlug}
              onboardingIncomplete={onboardingIncomplete}
              whatsappNeedsAttention={whatsappNeedsAttention}
              isOwner={isOwner}
              billingOnly={billingOnly}
              brand={<Brand tenantName={tenantName} />}
              footer={
                <>
                  <UserBlock userEmail={userEmail} userName={userName} accountHref={`/${tenantSlug}/minha-conta`} />
                  <TourReplayButton />
                </>
              }
            />
            <span className="truncate font-display text-sm font-bold text-text lg:hidden">{tenantName}</span>
            <TenantSectionLabel tenantSlug={tenantSlug} />
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {billingOnly ? null : <CommandPalette variant="tenant" tenantSlug={tenantSlug} />}
            <WhatsappStatusChip status={whatsappStatus} />
            <NotificationBell timezone={timezone} />
          </div>
        </header>

        <SubscriptionBanner tenantSlug={tenantSlug} timezone={timezone} state={billingBanner} serverNowMs={billingNowMs} />
        {askBillingPhone && saveBillingContact ? <BillingPhonePrompt tenantSlug={tenantSlug} save={saveBillingContact} /> : null}
        {billingWhatsappProblem ? <BillingWhatsappProblemBanner tenantSlug={tenantSlug} phoneDisplay={billingWhatsappProblem.phoneDisplay} /> : null}
        {!emailVerified ? <EmailVerificationBanner /> : null}

        <main className="flex-1 p-4 pb-16 sm:p-6 sm:pb-16">
          <PageTransition>
            <CanceledGate tenantSlug={tenantSlug} canceled={billingOnly}>
              {children}
            </CanceledGate>
          </PageTransition>
        </main>
      </div>
      <InnovareCodeBadge />
    </div>
    </NotificationCenterProvider>
    </OnboardingTourProvider>
  );
}
