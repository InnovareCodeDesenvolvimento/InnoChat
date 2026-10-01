import { notFound } from "next/navigation";
import { CreditCard } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getPrisma } from "@/lib/db/prisma";
import { auth } from "@/lib/auth";
import { accessEndsAt, CANCELED_RETENTION_DAYS, effectiveStatus } from "@/core/billing";
import { addDays } from "date-fns";
import { listActivePlansAction, type PlanListItem } from "@/modules/billing/actions";
import { AssinaturaClient, type BillingSnapshot } from "./assinatura-client";

export default async function AssinaturaPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, timezone: true, document: true },
  });
  if (!tenant) {
    notFound();
  }

  const subscription = await getPrisma().subscription.findUnique({
    where: { tenantId: tenant.id },
    include: { plan: true },
  });

  if (!subscription) {
    return (
      <div>
        <PageHeader help="pagina.assinatura" icon={navIconFor("assinatura")} title="Assinatura" description="Plano atual, fatura em aberto e histórico." />
        <EmptyState icon={CreditCard} title="Sem assinatura" description="Nenhuma assinatura encontrada para esta empresa. Contate o suporte." />
      </div>
    );
  }

  const now = new Date();
  const status = effectiveStatus(subscription, now);

  const [openInvoice, pendingPlan, session] = await Promise.all([
    getPrisma().invoice.findFirst({
      where: { subscriptionId: subscription.id, status: "OPEN" },
      orderBy: { periodStart: "desc" },
    }),
    subscription.pendingPlanId
      ? getPrisma().plan.findUnique({ where: { id: subscription.pendingPlanId }, select: { name: true } })
      : Promise.resolve(null),
    auth(),
  ]);

  const membership = session?.user?.id
    ? await getPrisma().membership.findFirst({
        where: { userId: session.user.id, tenant: { slug: tenantSlug } },
        select: { role: true },
      })
    : null;

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
      isOwner={membership?.role === "OWNER"}
      hasDocument={!!tenant.document}
    />
  );
}
