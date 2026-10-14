import { UserCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { parsePageSize, parsePositiveInt } from "@/components/lib/pagination";
import { listRescueLeadsAction } from "@/modules/rescue/admin-actions";
import { RescueListClient } from "@/components/admin/rescue/rescue-list-client";
import type { RescueLeadStatus } from "@/modules/rescue/service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SearchParams = {
  busca?: string;
  status?: string;
  de?: string;
  ate?: string;
  ordem?: string;
  pagina?: string;
  porPagina?: string;
};

export default async function AdminResgatePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const page = parsePositiveInt(sp.pagina, 1);
  const pageSize = parsePageSize(sp.porPagina);

  const filters = {
    search: sp.busca?.trim().slice(0, 120) || undefined,
    status: sp.status as RescueLeadStatus | undefined,
    from: sp.de && DATE_RE.test(sp.de) ? sp.de : undefined,
    to: sp.ate && DATE_RE.test(sp.ate) ? sp.ate : undefined,
    orderBy: (sp.ordem as "createdAt_desc" | "createdAt_asc" | "nextRunAt_asc" | "nextRunAt_desc") || "createdAt_desc",
    page,
    pageSize,
  };

  const result = await listRescueLeadsAction(filters);

  if (!result.ok) {
    return (
      <div>
        <PageHeader
          icon={UserCheck}
          title="Resgate de leads"
          description="Acompanhe e recupere cadastros que ainda não acessaram o painel da empresa."
          help="pagina.adminResgate"
        />
        <EmptyState icon={UserCheck} title="Não deu para carregar a lista de leads" description={result.error.message} />
      </div>
    );
  }

  return <RescueListClient data={result.data} filters={filters} />;
}
