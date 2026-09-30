import { notFound } from "next/navigation";
import { Calendar } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getPrisma } from "@/lib/db/prisma";
import { listProfessionalsAction, listServicesAction } from "@/modules/agenda/catalog-actions";
import { isTenantWriteBlocked } from "../_lib/write-blocked";
import { AgendaClient } from "./agenda-client";
import type { ProfessionalRow } from "../profissionais/profissionais-client";
import type { ServiceRow } from "../servicos/servicos-client";

export default async function AgendaPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, timezone: true, notifyClientOnStaffChanges: true } });
  if (!tenant) {
    notFound();
  }
  const writeBlocked = await isTenantWriteBlocked(tenant.id);

  const [professionalsResult, servicesResult] = await Promise.all([
    listProfessionalsAction(tenantSlug),
    listServicesAction(tenantSlug),
  ]);

  const professionals = professionalsResult.ok ? (professionalsResult.data as ProfessionalRow[]) : [];
  const services = servicesResult.ok ? (servicesResult.data as ServiceRow[]) : [];

  if (professionals.filter((p) => p.active).length === 0) {
    return (
      <div>
        <PageHeader help="pagina.agenda" icon={navIconFor("agenda")} title="Agenda" description="Dia e semana por profissional." />
        <EmptyState
          icon={Calendar}
          title="Cadastre um profissional ativo para começar"
          description="A agenda mostra os horários de cada profissional ativo. Vá em Profissionais para criar o primeiro."
        />
      </div>
    );
  }

  return (
    <AgendaClient
      tenantSlug={tenantSlug}
      timezone={tenant.timezone}
      notifyClient={tenant.notifyClientOnStaffChanges}
      professionals={professionals}
      services={services}
      writeBlocked={writeBlocked}
    />
  );
}
