import { Receipt } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { billingMonthlyTotalsAction, listDelinquentCompaniesAction, listInvoicesAdminAction } from "@/modules/billing/admin-actions";
import { AdminCobrancaClient } from "./admin-cobranca-client";

export default async function AdminCobrancaPage() {
  const [totalsResult, invoicesResult, delinquentsResult] = await Promise.all([
    billingMonthlyTotalsAction(),
    listInvoicesAdminAction(),
    listDelinquentCompaniesAction(),
  ]);

  if (!totalsResult.ok || !invoicesResult.ok || !delinquentsResult.ok) {
    const error = !totalsResult.ok ? totalsResult.error : !invoicesResult.ok ? invoicesResult.error : (delinquentsResult as { ok: false; error: { message: string } }).error;
    return (
      <div>
        <PageHeader icon={navIconFor("admin/cobranca")} title="Cobranças" description="Faturas abertas, vencidas e eventos do Mercado Pago." />
        <EmptyState icon={Receipt} title="Não deu para carregar a cobrança" description={error.message} />
      </div>
    );
  }

  const invoices = invoicesResult.data.items.map((item) => ({
    ...item,
    periodStart: item.periodStart.toISOString(),
    periodEnd: item.periodEnd.toISOString(),
    dueAt: item.dueAt.toISOString(),
    paidAt: item.paidAt ? item.paidAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
  }));

  return (
    <AdminCobrancaClient
      totals={totalsResult.data}
      initialItems={invoices}
      initialPaging={{ page: invoicesResult.data.page, pageSize: invoicesResult.data.pageSize, totalItems: invoicesResult.data.totalItems, totalPages: invoicesResult.data.totalPages }}
      delinquents={delinquentsResult.data}
    />
  );
}
