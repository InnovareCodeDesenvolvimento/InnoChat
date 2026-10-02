import { History } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { navIconFor } from "@/components/shell/nav-items";
import { AuditLogView } from "@/components/audit/audit-log-view";
import { parsePageSize, parsePositiveInt } from "@/components/lib/pagination";
import { listAdminAuditAction } from "@/modules/audit/actions";
import { AUDIT_AREAS } from "@/modules/audit/labels";
import type { AuditFilters } from "@/modules/audit/queries";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SearchParams = { empresa?: string; area?: string; pessoa?: string; de?: string; ate?: string; pagina?: string; porPagina?: string };

const TITLE = "Auditoria";
const DESCRIPTION = "Quem mudou o quê, em todas as empresas e na plataforma.";

export default async function AdminAuditoriaPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const filters: AuditFilters = {
    tenantQuery: sp.empresa?.trim().slice(0, 120) || undefined,
    area: AUDIT_AREAS.find((a) => a.id === sp.area)?.id,
    actor: sp.pessoa?.trim().slice(0, 120) || undefined,
    from: sp.de && DATE_RE.test(sp.de) ? sp.de : undefined,
    to: sp.ate && DATE_RE.test(sp.ate) ? sp.ate : undefined,
  };
  const page = parsePositiveInt(sp.pagina, 1);
  const pageSize = parsePageSize(sp.porPagina);
  const result = await listAdminAuditAction({ ...filters, page, pageSize });

  return (
    <div>
      <PageHeader icon={navIconFor("admin/auditoria")} title={TITLE} description={DESCRIPTION} help="pagina.adminAuditoria" />
      {result.ok ? (
        <AuditLogView data={result.data} filters={filters} variant="admin" />
      ) : (
        <EmptyState icon={History} title="Não deu para carregar o histórico" description={result.error.message} />
      )}
    </div>
  );
}
