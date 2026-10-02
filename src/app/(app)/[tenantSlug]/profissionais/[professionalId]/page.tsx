import { notFound } from "next/navigation";
import { UserRound } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getPrisma } from "@/lib/db/prisma";
import { getCommissionConfigAction, listProfessionalsAction, listServicesAction } from "@/modules/agenda/catalog-actions";
import { listScheduleExceptionsAction } from "@/modules/agenda/catalog-actions";
import { isTenantWriteBlocked } from "../../_lib/write-blocked";
import { ProfessionalDetailClient } from "./professional-detail-client";
import type { ProfessionalRow } from "../profissionais-client";
import type { ServiceRow } from "../../servicos/servicos-client";

export default async function ProfessionalDetailPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; professionalId: string }>;
}) {
  const { tenantSlug, professionalId } = await params;

  const [professionalsResult, servicesResult, exceptionsResult, commissionResult] = await Promise.all([
    listProfessionalsAction(tenantSlug),
    listServicesAction(tenantSlug),
    listScheduleExceptionsAction(tenantSlug),
    // FORBIDDEN para STAFF: sem resposta ok, a tela nem monta o cartão de comissão.
    getCommissionConfigAction(tenantSlug),
  ]);

  if (!professionalsResult.ok) {
    return (
      <div>
        <PageHeader help="pagina.profissionalDetalhe" icon={navIconFor("profissionais")} title="Profissional" />
        <EmptyState icon={UserRound} title="Não deu para carregar" description={professionalsResult.error.message} />
      </div>
    );
  }

  const professional = (professionalsResult.data as ProfessionalRow[]).find((p) => p.id === professionalId);
  if (!professional) {
    notFound();
  }

  const services = servicesResult.ok ? (servicesResult.data as ServiceRow[]) : [];
  const exceptions = exceptionsResult.ok
    ? (exceptionsResult.data as {
        id: string;
        professionalId: string | null;
        type: "BLOCK" | "HOLIDAY";
        startsAt: string | Date;
        endsAt: string | Date;
        reason: string | null;
      }[]).filter((exc) => exc.professionalId === professionalId)
    : [];

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
  const writeBlocked = tenant ? await isTenantWriteBlocked(tenant.id) : false;

  return (
    <ProfessionalDetailClient
      tenantSlug={tenantSlug}
      professional={professional}
      allServices={services}
      writeBlocked={writeBlocked}
      commission={commissionResult.ok ? (commissionResult.data.find((c) => c.professionalId === professionalId) ?? null) : null}
      initialExceptions={exceptions.map((exc) => ({
        ...exc,
        startsAt: new Date(exc.startsAt).toISOString(),
        endsAt: new Date(exc.endsAt).toISOString(),
      }))}
    />
  );
}
