import { notFound } from "next/navigation";
import { getPrisma } from "@/lib/db/prisma";
import { requireTenantMember } from "@/lib/auth/guards";
import { listProfessionalsAction, listServicesAction } from "@/modules/agenda/catalog-actions";
import { isTenantWriteBlocked } from "../_lib/write-blocked";
import { AtendimentoClient } from "./atendimento-client";
import type { ProfessionalRow } from "../profissionais/profissionais-client";
import type { ServiceRow } from "../servicos/servicos-client";

export default async function AtendimentoPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, timezone: true, notifyClientOnStaffChanges: true } });
  if (!tenant) notFound();

  // Serviços e profissionais só alimentam o diálogo "Agendar para este cliente".
  const [professionalsResult, servicesResult, writeBlocked, memberCtx] = await Promise.all([
    listProfessionalsAction(tenantSlug),
    listServicesAction(tenantSlug),
    isTenantWriteBlocked(tenant.id),
    requireTenantMember(tenantSlug).catch(() => null),
  ]);

  const isSupportImpersonation = Boolean(memberCtx?.isSupportImpersonation);
  let supportAdminName: string | null = null;
  if (isSupportImpersonation && memberCtx?.user?.id) {
    const adminUser = await getPrisma().user.findUnique({
      where: { id: memberCtx.user.id },
      select: { name: true, email: true },
    });
    supportAdminName = adminUser?.name || adminUser?.email || "Suporte InnoChat";
  }

  return (
    <AtendimentoClient
      tenantSlug={tenantSlug}
      timezone={tenant.timezone}
      notifyClient={tenant.notifyClientOnStaffChanges}
      writeBlocked={writeBlocked}
      professionals={professionalsResult.ok ? (professionalsResult.data as ProfessionalRow[]) : []}
      services={servicesResult.ok ? (servicesResult.data as ServiceRow[]) : []}
      isSupportImpersonation={isSupportImpersonation}
      supportAdminName={supportAdminName}
    />
  );
}
