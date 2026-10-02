import { TicketPercent } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { navIconFor } from "@/components/shell/nav-items";
import { parsePageSize, parsePositiveInt } from "@/components/lib/pagination";
import { listPlansAction } from "@/modules/billing/admin-actions";
import { listCouponsAction } from "@/modules/billing/coupon-actions";
import { CuponsClient, type CouponFilters, type CouponRow } from "./cupons-client";

// Lê o banco a cada acesso (cupom novo precisa aparecer na hora) e não pode ser pré-renderizado no build.
export const dynamic = "force-dynamic";

type SearchParams = { busca?: string; situacao?: string; pagina?: string; porPagina?: string };

export default async function AdminCuponsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const filters: CouponFilters = {
    search: sp.busca?.trim().slice(0, 60) || "",
    status: sp.situacao === "ativos" ? "active" : sp.situacao === "desativados" ? "inactive" : "all",
  };
  const page = parsePositiveInt(sp.pagina, 1);
  const pageSize = parsePageSize(sp.porPagina);

  const [couponsResult, plansResult] = await Promise.all([
    listCouponsAction({ page, pageSize, search: filters.search || undefined, status: filters.status }),
    listPlansAction(),
  ]);

  if (!couponsResult.ok || !plansResult.ok) {
    const message = !couponsResult.ok ? couponsResult.error.message : !plansResult.ok ? plansResult.error.message : "";
    return (
      <div>
        <PageHeader icon={navIconFor("admin/cupons")} title="Cupons" description="Códigos de desconto para o cadastro e a tela Assinatura." help="admin.cupons" />
        <EmptyState icon={TicketPercent} title="Não deu para carregar os cupons" description={message} />
      </div>
    );
  }

  const items: CouponRow[] = couponsResult.data.items.map((c) => ({
    ...c,
    validFrom: c.validFrom ? c.validFrom.toISOString() : null,
    validUntil: c.validUntil ? c.validUntil.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  }));
  const { page: currentPage, pageSize: currentSize, totalItems, totalPages } = couponsResult.data;

  return (
    <CuponsClient
      items={items}
      paging={{ page: currentPage, pageSize: currentSize, totalItems, totalPages }}
      filters={filters}
      plans={plansResult.data.map((p) => ({ id: p.id, name: p.name }))}
    />
  );
}
