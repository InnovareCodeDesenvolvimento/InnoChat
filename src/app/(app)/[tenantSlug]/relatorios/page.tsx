import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { requireTenantMember } from "@/lib/auth/guards";
import { isDomainError } from "@/lib/errors";
import { getReport } from "@/modules/reports/service";
import { RelatoriosClient } from "./relatorios-client";

export const dynamic = "force-dynamic";

/**
 * Relatórios: SÓ o dono. O guard roda no servidor (`requireTenantMember(slug, ["OWNER"])`): STAFF recebe a
 * mensagem de acesso, sem que nenhum número saia do banco. O período vem da URL e é revalidado em
 * `resolveReportRange` (nunca confiado).
 */
export default async function RelatoriosPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ periodo?: string; de?: string; ate?: string }>;
}) {
  const { tenantSlug } = await params;
  const query = await searchParams;

  let ctx;
  try {
    ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
  } catch (error) {
    if (isDomainError(error) && error.code === "FORBIDDEN") {
      return (
        <div>
          <PageHeader help="pagina.relatorios" icon={navIconFor("relatorios")} title="Relatórios" description="Faturamento, ticket médio, faltas e comissões." />
          <EmptyState icon={BarChart3} title="Esta tela é só para o dono" description="Peça ao dono da empresa para abrir os relatórios." />
        </div>
      );
    }
    throw error;
  }

  const report = await getReport(ctx.tenant.id, ctx.tenant.timezone, { preset: query.periodo, from: query.de, to: query.ate });

  return (
    <RelatoriosClient
      tenantSlug={tenantSlug}
      range={{ preset: report.range.preset, from: report.range.from, to: report.range.to, days: report.range.days }}
      summary={report.summary}
      byService={report.byService}
      byProfessional={report.byProfessional}
    />
  );
}
