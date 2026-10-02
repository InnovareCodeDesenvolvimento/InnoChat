import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Banknote, CalendarClock, HandCoins, Repeat, Send, UserMinus, Users, Wallet } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { navIconFor } from "@/components/shell/nav-items";
import { BillingStatCard } from "@/components/admin/billing-ui";
import { getFinanceOverviewAction } from "@/modules/billing/finance-actions";
import { formatCentsBRL } from "@/modules/billing/format";
import { FinanceCsvCard } from "./finance-csv-card";

const TZ = "America/Sao_Paulo";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function Row({ label, value, dot }: { label: string; value: React.ReactNode; dot?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border py-2.5 first:border-t-0">
      <span className="flex items-center gap-2 text-sm text-text-secondary">
        {dot ? <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" /> : null}
        {label}
      </span>
      <span className="text-right text-sm font-semibold tabular-nums text-text">{value}</span>
    </div>
  );
}

export default async function AdminFinanceiroPage() {
  const result = await getFinanceOverviewAction();
  const header = (
    <PageHeader
      icon={navIconFor("admin/financeiro")}
      title="Financeiro"
      description="Receita, atrasos e cancelamentos das empresas, no horário de Brasília."
      help="pagina.adminFinanceiro"
    />
  );

  if (!result.ok) {
    return (
      <div>
        {header}
        <EmptyState icon={Wallet} title="Não deu para carregar o financeiro" description={result.error.message} />
      </div>
    );
  }

  const o = result.data;
  const now = new Date();
  const defaultTo = formatInTimeZone(now, TZ, "yyyy-MM-dd");
  const defaultFrom = formatInTimeZone(now, TZ, "yyyy-MM-01");

  const diff = o.receivedThisMonthCents - o.receivedLastMonthCents;
  const pct = o.receivedLastMonthCents > 0 ? Math.round((diff / o.receivedLastMonthCents) * 1000) / 10 : null;
  const ratePct = o.churn.ratePct;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={navIconFor("admin/financeiro")}
        title="Financeiro"
        description="Receita, atrasos e cancelamentos das empresas, no horário de Brasília."
        help="pagina.adminFinanceiro"
        className="mb-0"
        action={
          <Button asChild variant="secondary">
            <Link href="/admin/envios">
              <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
              Ver envios de cobrança
            </Link>
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <BillingStatCard icon={<Repeat aria-hidden="true" />} label="Receita mensal recorrente" value={formatCentsBRL(o.mrrCents)} tone="primary" help="admin.receitaMensal">
          <p className="mt-3 text-xs text-text-secondary">Só quem paga. Teste e suspensas ficam de fora.</p>
        </BillingStatCard>

        <BillingStatCard icon={<Banknote aria-hidden="true" />} label="Recebido no mês" value={formatCentsBRL(o.receivedThisMonthCents)} tone="success" help="admin.recebidoMes">
          <span className="mt-3 inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2.5 py-1 text-xs font-medium text-text-secondary">
            {pct === null ? (
              "Sem recebimentos no mês passado"
            ) : (
              <>
                {diff >= 0 ? <ArrowUpRight className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <ArrowDownRight className="h-3.5 w-3.5 text-danger" aria-hidden="true" />}
                {`${diff >= 0 ? "+" : ""}${pct.toLocaleString("pt-BR")}% sobre o mês passado`}
              </>
            )}
          </span>
          <p className="mt-2 text-xs text-text-secondary">Mês passado: {formatCentsBRL(o.receivedLastMonthCents)}</p>
        </BillingStatCard>

        <BillingStatCard icon={<AlertTriangle aria-hidden="true" />} label="Faturas atrasadas" value={formatCentsBRL(o.delinquency.cents)} tone="danger" help="admin.inadimplencia">
          <p className="mt-3 text-xs text-text-secondary">
            {o.delinquency.count === 0
              ? "Nenhuma fatura atrasada."
              : `${plural(o.delinquency.count, "fatura", "faturas")}, ${o.delinquency.over30DaysCount} com mais de 30 dias.`}
          </p>
        </BillingStatCard>

        <BillingStatCard icon={<HandCoins aria-hidden="true" />} label="Recuperados pelos avisos" value={formatCentsBRL(o.recoveredThisMonth.cents)} tone="success" help="admin.recuperados">
          <p className="mt-3 text-xs text-text-secondary">
            {o.recoveredThisMonth.count === 0
              ? "Ninguém pagou depois de atrasar neste mês."
              : `${plural(o.recoveredThisMonth.count, "pagamento", "pagamentos")} de quem estava atrasado ou suspenso.`}
          </p>
        </BillingStatCard>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <BillingStatCard icon={<Users aria-hidden="true" />} label="Assinantes" tone="primary" help="admin.assinantes">
          <div className="mt-3">
            <Row dot="bg-primary" label="Em teste" value={o.subscribers.trialing} />
            <Row dot="bg-success" label="Ativas" value={o.subscribers.active} />
            <Row dot="bg-warning" label="Fatura atrasada" value={o.subscribers.pastDue} />
            <Row dot="bg-danger" label="Suspensas" value={o.subscribers.suspended} />
          </div>
        </BillingStatCard>

        <BillingStatCard icon={<CalendarClock aria-hidden="true" />} label="Próximos vencimentos" tone="warning" help="admin.proximosVencimentos">
          <div className="mt-3">
            <Row label="Nos próximos 7 dias" value={`${plural(o.upcoming.next7.count, "fatura", "faturas")} · ${formatCentsBRL(o.upcoming.next7.cents)}`} />
            <Row label="Nos próximos 30 dias" value={`${plural(o.upcoming.next30.count, "fatura", "faturas")} · ${formatCentsBRL(o.upcoming.next30.cents)}`} />
          </div>
        </BillingStatCard>

        <BillingStatCard icon={<UserMinus aria-hidden="true" />} label="Cancelamentos do mês" tone="danger" help="admin.cancelamentos">
          <p className="mt-1 font-display text-3xl font-black tabular-nums text-text">{o.churn.canceledCount}</p>
          <div className="mt-3">
            <Row label="Pediram para sair" value={o.churn.voluntary} />
            <Row label="Por falta de pagamento" value={o.churn.involuntary} />
            <Row label="Taxa do mês" value={ratePct === null ? "Sem base" : `${ratePct.toLocaleString("pt-BR")}%`} />
            <p className="mt-2 text-xs text-text-secondary">
              {o.churn.baseAtMonthStart === 0
                ? "Ninguém pagava no começo do mês, então não há taxa."
                : `Base: ${plural(o.churn.baseAtMonthStart, "empresa pagante", "empresas pagantes")} no começo do mês.`}
            </p>
          </div>
        </BillingStatCard>
      </div>

      <FinanceCsvCard defaultFrom={defaultFrom} defaultTo={defaultTo} />

      {o.approximateHistory.hasBackfilledEvents ? (
        <Alert variant="info">Os cancelamentos de antes da nova régua de cobrança foram estimados pelas datas das faturas e das assinaturas. Os do mês corrente em diante são exatos.</Alert>
      ) : null}

      <p className="text-xs text-text-secondary">Números calculados às {formatInTimeZone(new Date(o.asOf), TZ, "HH:mm")}, horário de Brasília.</p>
    </div>
  );
}
