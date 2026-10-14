import { notFound } from "next/navigation";
import { getPrisma } from "@/lib/db/prisma";
import { requireTenantMember } from "@/lib/auth/guards";
import { listProfessionalsAction, listServicesAction } from "@/modules/agenda/catalog-actions";
import { AgendamentosClient } from "./agendamentos-client";
import type { ProfessionalRow } from "../profissionais/profissionais-client";
import type { ServiceRow } from "../servicos/servicos-client";

export default async function AgendamentosPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { timezone: true, notifyClientOnStaffChanges: true } });
  if (!tenant) {
    notFound();
  }

  const [professionalsResult, servicesResult, memberCtx] = await Promise.all([
    listProfessionalsAction(tenantSlug),
    listServicesAction(tenantSlug),
    requireTenantMember(tenantSlug).catch(() => null),
  ]);

  const isSupportImpersonation = Boolean(memberCtx?.isSupportImpersonation);
  const professionals = professionalsResult.ok ? (professionalsResult.data as ProfessionalRow[]) : [];
  const services = servicesResult.ok ? (servicesResult.data as ServiceRow[]) : [];

  return (
    <AgendamentosClient
      tenantSlug={tenantSlug}
      timezone={tenant.timezone}
      notifyClient={tenant.notifyClientOnStaffChanges}
      professionals={professionals}
      services={services}
      isSupportImpersonation={isSupportImpersonation}
    />
  );
}
