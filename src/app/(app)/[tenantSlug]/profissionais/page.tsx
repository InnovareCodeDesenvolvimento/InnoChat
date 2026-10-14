import { UserRound } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getPrisma } from "@/lib/db/prisma";
import { requireTenantMember } from "@/lib/auth/guards";
import { listProfessionalsAction } from "@/modules/agenda/catalog-actions";
import { isTenantWriteBlocked } from "../_lib/write-blocked";
import { ProfissionaisClient, type ProfessionalRow } from "./profissionais-client";

export default async function ProfissionaisPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const [result, memberCtx] = await Promise.all([
    listProfessionalsAction(tenantSlug),
    requireTenantMember(tenantSlug).catch(() => null),
  ]);

  const isSupportImpersonation = Boolean(memberCtx?.isSupportImpersonation);

  if (!result.ok) {
    return (
      <div>
        <PageHeader help="pagina.profissionais" icon={navIconFor("profissionais")} title="Profissionais" description="Expediente semanal e serviços de cada um." />
        <EmptyState
          icon={UserRound}
          title="Não deu para carregar os profissionais"
          description={result.error.message}
        />
      </div>
    );
  }

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
  const writeBlocked = tenant ? await isTenantWriteBlocked(tenant.id) : false;

  return (
    <ProfissionaisClient
      tenantSlug={tenantSlug}
      initialProfessionals={result.data as ProfessionalRow[]}
      writeBlocked={writeBlocked}
      isSupportImpersonation={isSupportImpersonation}
    />
  );
}
