import { TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { navIconFor } from "@/components/shell/nav-items";
import { parsePageSize, parsePositiveInt } from "@/components/lib/pagination";
import { listErrorGroupsAction } from "@/modules/error-monitor/actions";
import { ErrosClient, type ErrosFilters } from "./erros-client";

export const dynamic = "force-dynamic";

const STATUSES = ["OPEN", "RESOLVED", "IGNORED"] as const;
const SOURCES = ["SERVER", "CLIENT"] as const;

type SearchParams = { status?: string; origem?: string; pagina?: string; porPagina?: string };

export default async function AdminErrosPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const filters: ErrosFilters = {
    status: STATUSES.find((s) => s === sp.status),
    source: SOURCES.find((s) => s === sp.origem),
  };
  const page = parsePositiveInt(sp.pagina, 1);
  const pageSize = parsePageSize(sp.porPagina) as 10 | 25 | 50 | 100;
  const result = await listErrorGroupsAction({ ...filters, page, pageSize });

  if (!result.ok) {
    return (
      <div>
        <PageHeader
          icon={navIconFor("admin/erros")}
          title="Erros"
          description="Os erros que o sistema registrou sozinho, juntando os que se repetem."
          help="pagina.adminErros"
        />
        <EmptyState icon={TriangleAlert} title="Não deu para carregar os erros" description={result.error.message} />
      </div>
    );
  }
  return <ErrosClient data={result.data} filters={filters} />;
}
