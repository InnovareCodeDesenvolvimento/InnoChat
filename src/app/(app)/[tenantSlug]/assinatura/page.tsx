import { notFound, redirect } from "next/navigation";
import { CreditCard } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getPrisma } from "@/lib/db/prisma";
import { auth } from "@/lib/auth";
import { accessEndsAt, CANCELED_RETENTION_DAYS, effectiveStatus } from "@/core/billing";
import { addDays } from "date-fns";
import { listActivePlansAction, type PlanListItem } from "@/modules/billing/actions";
import { resolveBillingBanner } from "@/components/shell/billing-banner-state";
import type { PaymentHistoryItem } from "@/components/billing/payment-history-card";
import { updateBillingContactAction } from "@/modules/billing/contact-actions";
import { AssinaturaClient, type BillingSnapshot } from "./assinatura-client";

export default async function AssinaturaPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ pagar?: string }>;
}) {
  const { tenantSlug } = await params;
  // `?pagar=pix` (botão "Pagar com Pix" do banner): a tela abre já no cartão do Pix.
  const focusPix = (await searchParams).pagar === "pix";

  const tenant = await getPrisma().tenant.findUnique({
    where: { slug: tenantSlug },
    select: {
      id: true,
      timezone: true,
      document: true,
      billingEmail: true,
      billingWhatsappE164: true,
      billingWhatsappOptOutAt: true,
      billingWhatsappConfirmedAt: true,
    },
  });
  if (!tenant) {
    notFound();
  }

  // O layout já barra quem não é da empresa, mas a página também confere (defesa em profundidade: o `slug` da URL
  // é dado externo e esta página lê a fatura, o Pix e o contato de cobrança). Sem vínculo = 404, como no layout.
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const membership = await getPrisma().membership.findFirst({
    where: { userId: session.user.id, tenantId: tenant.id },
    select: { role: true },
  });
  if (!membership) notFound();

  const subscription = await getPrisma().subscription.findUnique({
    where: { tenantId: tenant.id },
    include: { plan: true },
  });

  if (!subscription) {
    return (
      <div>
        <PageHeader help="pagina.assinatura" icon={navIconFor("assinatura")} title="Assinatura" description="Plano atual, fatura em aberto e histórico." />
        <EmptyState icon={CreditCard} title="Sem assinatura" description="Não encontramos assinatura para esta empresa. Fale com o suporte." />
      </div>
    );
  }

  const now = new Date();
  const status = effectiveStatus(subscription, now);

  const [openInvoice, pendingPlan, invoiceRows, ownerMembership] = await Promise.all([
    getPrisma().invoice.findFirst({
      where: { subscriptionId: subscription.id, status: "OPEN" },
      orderBy: { periodStart: "desc" },
    }),
    subscription.pendingPlanId
      ? getPrisma().plan.findUnique({ where: { id: subscription.pendingPlanId }, select: { name: true } })
      : Promise.resolve(null),
    // Histórico: pagas e a em aberto (VOID/EXPIRED não interessam à empresa), com o `tenantId`
    // explícito pela relação: o Prisma aqui é o cru, sem o filtro automático do `forTenant`.
    getPrisma().invoice.findMany({
      where: { subscription: { tenantId: tenant.id }, status: { in: ["PAID", "OPEN"] } },
      orderBy: { periodStart: "desc" },
      take: 12,
      select: { id: true, amountCents: true, periodStart: true, periodEnd: true, status: true, paidAt: true },
    }),
    getPrisma().membership.findFirst({
      where: { tenantId: tenant.id, role: "OWNER" },
      orderBy: { createdAt: "asc" },
      select: { user: { select: { email: true } } },
    }),
  ]);
  const history: PaymentHistoryItem[] = invoiceRows.map((row) => ({
    id: row.id,
    amountCents: row.amountCents,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status === "PAID" ? "PAID" : "OPEN",
    paidAt: row.paidAt?.toISOString() ?? null,
  }));
  const lastPaidAt = invoiceRows.find((row) => row.status === "PAID")?.paidAt ?? null;
  const banner = resolveBillingBanner({ subscription: { ...subscription, timezone: tenant.timezone }, openInvoice, lastPaidAt }, now);

  const plansResult = await listActivePlansAction(tenantSlug);
  const plans: PlanListItem[] = plansResult.ok ? plansResult.data : [];

  // Cancelada por agendamento cuja data já passou (o tick ainda não gravou `canceledAt`): vale a data de término.
  const canceledAt = subscription.canceledAt ?? (status === "CANCELED" && subscription.cancelAtPeriodEnd ? accessEndsAt(subscription) : null);

  const snapshot: BillingSnapshot = {
    planId: subscription.planId,
    planName: subscription.plan.name,
    planSortOrder: subscription.plan.sortOrder,
    priceCents: subscription.plan.priceCents,
    status,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    timezone: tenant.timezone,
    pendingPlanId: subscription.pendingPlanId,
    pendingPlanName: pendingPlan?.name ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    accessEndsAt: subscription.cancelAtPeriodEnd ? accessEndsAt(subscription).toISOString() : null,
    canceledAt: canceledAt?.toISOString() ?? null,
    retentionEndsAt: canceledAt ? addDays(canceledAt, CANCELED_RETENTION_DAYS).toISOString() : null,
    // Passaram os 90 dias: os dados dos clientes finais já foram (ou estão sendo) anonimizados.
    dataAnonymized: canceledAt ? addDays(canceledAt, CANCELED_RETENTION_DAYS) <= now : false,
    invoice: openInvoice
      ? {
          id: openInvoice.id,
          amountCents: openInvoice.amountCents,
          dueAt: openInvoice.dueAt.toISOString(),
          pixCopyPaste: openInvoice.pixCopyPaste,
          pixExpiresAt: openInvoice.pixExpiresAt?.toISOString() ?? null,
          paidAt: openInvoice.paidAt?.toISOString() ?? null,
        }
      : null,
  };

  return (
    <AssinaturaClient
      tenantSlug={tenantSlug}
      snapshot={snapshot}
      plans={plans}
      isOwner={membership.role === "OWNER"}
      hasDocument={!!tenant.document}
      focusPix={focusPix}
      renewedUntil={banner?.kind === "RENEWED" ? banner.until : null}
      history={history}
      contact={{
        billingEmail: tenant.billingEmail,
        billingWhatsappE164: tenant.billingWhatsappE164,
        optedOut: tenant.billingWhatsappOptOutAt !== null,
        whatsappConfirmed: tenant.billingWhatsappConfirmedAt !== null,
        // O e-mail do dono só vai para quem pode editar (serve ao texto "sem e-mail aqui, vai para...").
        ownerEmail: membership.role === "OWNER" ? (ownerMembership?.user.email ?? null) : null,
      }}
      saveContact={updateBillingContactAction}
    />
  );
}
