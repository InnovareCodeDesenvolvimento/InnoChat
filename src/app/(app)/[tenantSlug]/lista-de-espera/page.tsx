import { notFound } from "next/navigation";
import { getPrisma } from "@/lib/db/prisma";
import { listProfessionalsAction, listServicesAction } from "@/modules/agenda/catalog-actions";
import type { ProfessionalRow } from "../profissionais/profissionais-client";
import type { ServiceRow } from "../servicos/servicos-client";
import { ListaEsperaClient } from "./lista-espera-client";

export default async function ListaEsperaPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { timezone: true } });
  if (!tenant) notFound();

  const [professionalsResult, servicesResult] = await Promise.all([listProfessionalsAction(tenantSlug), listServicesAction(tenantSlug)]);
  const professionals = professionalsResult.ok ? (professionalsResult.data as ProfessionalRow[]) : [];
  const services = servicesResult.ok ? (servicesResult.data as ServiceRow[]) : [];

  return <ListaEsperaClient tenantSlug={tenantSlug} timezone={tenant.timezone} professionals={professionals} services={services} />;
}
