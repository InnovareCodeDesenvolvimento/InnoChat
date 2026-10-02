import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building2, CalendarClock, HandCoins, Layers, Mail, Send } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { navIconFor } from "@/components/shell/nav-items";
import { BillingStatCard } from "@/components/admin/billing-ui";
import { getCompanyBillingAction, listCompanyBillingTimelineAction } from "@/modules/billing/finance-actions";
import { SUBSCRIPTION_STATUS_LABEL, SUBSCRIPTION_STATUS_VARIANT } from "@/components/admin/billing-labels";
import { formatCentsBRL, formatDateBR } from "@/modules/billing/format";
import { parsePageSize, parsePositiveInt } from "@/components/lib/pagination";
import { TwoFactorResetList } from "@/components/admin/two-factor-reset-list";
import { listCompanyTwoFactorAction } from "@/modules/two-factor/actions";
import { CompanyInvoices } from "./company-invoices";
import { CompanyTimeline } from "./company-timeline";

export default async function AdminEmpresaCobrancaPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ pagina?: string; porPagina?: string }>;
}) {
  const { tenantId } = await params;
  const sp = await searchParams;
  const page = parsePositiveInt(sp.pagina, 1);
  const pageSize = parsePageSize(sp.porPagina);
  const [billing, timeline, team] = await Promise.all([
    getCompanyBillingAction(tenantId),
    listCompanyBillingTimelineAction(tenantId, { page, pageSize }),
    listCompanyTwoFactorAction(tenantId),
  ]);

  if (!billing.ok) {
    if (billing.error.code === "NOT_FOUND") notFound();
    return (
      <div>
        <PageHeader
          icon={navIconFor("admin/empresas")}
          title="Cobrança da empresa"
          description="Plano, faturas e tudo o que aconteceu na cobrança."
          help="pagina.adminEmpresaCobranca"
        />
        <EmptyState icon={Building2} title="Não deu para carregar a cobrança desta empresa" description={billing.error.message} />
      </div>
    );
  }

  const { company, invoices, lifetimeValueCents } = billing.data;
  const statusLabel = SUBSCRIPTION_STATUS_LABEL[company.status] ?? company.status;
  const statusVariant = SUBSCRIPTION_STATUS_VARIANT[company.status] ?? "neutral";
  const firstPaidAt = company.firstPaidAt ? new Date(company.firstPaidAt) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={navIconFor("admin/empresas")}
        className="mb-0"
        title={
          <span className="flex items-center gap-3">
            <Avatar id={company.id} name={company.name} size="md" />
            <span className="min-w-0 break-words">{company.name}</span>
          </span>
        }
        description={`/${company.slug}. Cobrança, faturas e avisos enviados.`}
        help="pagina.adminEmpresaCobranca"
        action={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button asChild variant="secondary">
              <Link href="/admin/empresas">
                <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
                Voltar para Empresas
              </Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href={`/admin/envios?tenantQuery=${encodeURIComponent(company.name)}`}>
                <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
                Ver todos os envios
              </Link>
            </Button>
          </div>
        }
      />

      <section aria-label="Resumo da cobrança" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <BillingStatCard icon={<Layers aria-hidden="true" />} label="Plano" value={company.planName} tone="primary">
          <div className="mt-3">
            <Badge variant={statusVariant}>{statusLabel}</Badge>
          </div>
        </BillingStatCard>
        <BillingStatCard icon={<CalendarClock aria-hidden="true" />} label="Próximo vencimento" value={formatDateBR(new Date(company.currentPeriodEnd))} tone="warning" />
        <BillingStatCard icon={<HandCoins aria-hidden="true" />} label="Pago desde o início" value={formatCentsBRL(lifetimeValueCents)} tone="success">
          <p className="mt-3 text-xs text-text-secondary">
            {firstPaidAt ? `Primeiro pagamento em ${formatDateBR(firstPaidAt)}.` : "Ainda não fez nenhum pagamento."}
          </p>
        </BillingStatCard>
        <BillingStatCard icon={<Mail aria-hidden="true" />} label="Onde os avisos chegam" tone="primary">
          <p className="mt-1 break-all text-sm font-semibold text-text">{company.billingEmailMasked ?? "E-mail do dono da empresa"}</p>
          <p className="mt-2 break-all text-xs text-text-secondary">
            {company.whatsappOptIn
              ? `Aceitou receber avisos por WhatsApp${company.billingWhatsappMasked ? `, no ${company.billingWhatsappMasked}` : ""}.`
              : "Não aceitou avisos por WhatsApp."}
          </p>
        </BillingStatCard>
      </section>

      <CompanyInvoices
        invoices={invoices.map((inv) => ({
          id: inv.id,
          amountCents: inv.amountCents,
          status: inv.status,
          periodStart: new Date(inv.periodStart).toISOString(),
          periodEnd: new Date(inv.periodEnd).toISOString(),
          dueAt: new Date(inv.dueAt).toISOString(),
          paidAt: inv.paidAt ? new Date(inv.paidAt).toISOString() : null,
          kind: inv.kind,
        }))}
      />

      {team.ok ? (
        <Card className="rounded-hero">
          <CardHeader help="admin.doisFatores">
            <CardTitle>Equipe e verificação em 2 etapas</CardTitle>
            <CardDescription>Quem acessa esta empresa. Redefina a verificação de quem perdeu o celular.</CardDescription>
          </CardHeader>
          <TwoFactorResetList rows={team.data} emptyText="Esta empresa ainda não tem pessoas cadastradas." />
        </Card>
      ) : null}

      <Card className="rounded-hero">
        <CardHeader help="admin.linhaDoTempo">
          <CardTitle>Linha do tempo</CardTitle>
          <CardDescription>Avisos enviados e mudanças na assinatura, do mais novo para o mais antigo.</CardDescription>
        </CardHeader>
        <div className="p-5">
          {timeline.ok ? (
            <CompanyTimeline data={timeline.data} />
          ) : (
            <EmptyState title="Não deu para carregar a linha do tempo" description={timeline.error.message} />
          )}
        </div>
      </Card>
    </div>
  );
}
