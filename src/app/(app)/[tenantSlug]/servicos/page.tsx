import { Scissors } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getPrisma } from "@/lib/db/prisma";
import { requireTenantMember } from "@/lib/auth/guards";
import { listServicesAction } from "@/modules/agenda/catalog-actions";
import { isTenantWriteBlocked } from "../_lib/write-blocked";
import { ServicosClient, type ServiceRow } from "./servicos-client";

export default async function ServicosPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const [result, memberCtx] = await Promise.all([
    listServicesAction(tenantSlug),
    requireTenantMember(tenantSlug).catch(() => null),
  ]);

  const isSupportImpersonation = Boolean(memberCtx?.isSupportImpersonation);

  if (!result.ok) {
    return (
      <div>
        <PageHeader help="pagina.servicos" icon={navIconFor("servicos")} title="Serviços" description="Nome, duração, intervalo, preço opcional e ordem." />
        <EmptyState
          icon={Scissors}
          title="Não deu para carregar os serviços"
          description={result.error.message}
        />
      </div>
    );
  }

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
  const writeBlocked = tenant ? await isTenantWriteBlocked(tenant.id) : false;

  return (
    <ServicosClient
      tenantSlug={tenantSlug}
      initialServices={result.data as ServiceRow[]}
      writeBlocked={writeBlocked}
      isSupportImpersonation={isSupportImpersonation}
    />
  );
}
