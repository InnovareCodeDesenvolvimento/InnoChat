import { notFound } from "next/navigation";
import { History } from "lucide-react";
import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { navIconFor } from "@/components/shell/nav-items";
import { AuditLogView } from "@/components/audit/audit-log-view";
import { parsePageSize, parsePositiveInt } from "@/components/lib/pagination";
import { listTenantAuditAction } from "@/modules/audit/actions";
import { AUDIT_AREAS } from "@/modules/audit/labels";
import type { AuditFilters } from "@/modules/audit/queries";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SearchParams = { area?: string; pessoa?: string; de?: string; ate?: string; pagina?: string; porPagina?: string };

const TITLE = "Histórico de alterações";
const DESCRIPTION = "Quem da equipe mudou o quê no painel, e quando.";

export default async function HistoricoPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ tenantSlug }, sp] = await Promise.all([params, searchParams]);

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, timezone: true } });
  if (!tenant) notFound();

  const session = await auth();
  const membership = session?.user?.id ? await forTenant(tenant.id).membership.findFirst({ where: { userId: session.user.id } }) : null;
  if (!membership) notFound();

  const header = <PageHeader icon={navIconFor("configuracoes")} title={TITLE} description={DESCRIPTION} help="pagina.historicoAlteracoes" />;

  if (membership.role !== "OWNER") {
    return (
      <div>
        {header}
        <EmptyState icon={History} title="Só o dono vê o histórico" description="Peça ao dono da empresa para consultar quem mudou o quê no painel." />
      </div>
    );
  }

  const filters: AuditFilters = {
    area: AUDIT_AREAS.find((a) => a.id === sp.area && !a.platformOnly)?.id,
    actor: sp.pessoa?.trim().slice(0, 120) || undefined,
    from: sp.de && DATE_RE.test(sp.de) ? sp.de : undefined,
    to: sp.ate && DATE_RE.test(sp.ate) ? sp.ate : undefined,
  };
  const result = await listTenantAuditAction(tenantSlug, { ...filters, page: parsePositiveInt(sp.pagina, 1), pageSize: parsePageSize(sp.porPagina) });

  return (
    <div>
      {header}
      {result.ok ? (
        <AuditLogView data={result.data} filters={filters} variant="tenant" timezone={tenant.timezone} />
      ) : (
        <EmptyState icon={History} title="Não deu para carregar o histórico" description={result.error.message} />
      )}
    </div>
  );
}
