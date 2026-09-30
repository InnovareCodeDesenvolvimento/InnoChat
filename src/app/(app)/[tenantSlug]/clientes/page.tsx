import { notFound } from "next/navigation";
import { getPrisma } from "@/lib/db/prisma";
import { auth } from "@/lib/auth";
import { listContactsAction } from "@/modules/contacts/actions";
import { listProfessionalsAction, listServicesAction } from "@/modules/agenda/catalog-actions";
import { isTenantWriteBlocked } from "../_lib/write-blocked";
import { ClientesClient, type ContactListItem } from "./clientes-client";
import type { ProfessionalRow } from "../profissionais/profissionais-client";
import type { ServiceRow } from "../servicos/servicos-client";

export default async function ClientesPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, timezone: true, notifyClientOnStaffChanges: true } });
  if (!tenant) {
    notFound();
  }

  const session = await auth();
  const membership = session?.user?.id
    ? await getPrisma().membership.findFirst({
        where: { userId: session.user.id, tenant: { slug: tenantSlug } },
        select: { role: true },
      })
    : null;

  const [contactsResult, professionalsResult, servicesResult, writeBlocked] = await Promise.all([
    listContactsAction(tenantSlug, { filter: "all", limit: 20 }),
    listProfessionalsAction(tenantSlug),
    listServicesAction(tenantSlug),
    isTenantWriteBlocked(tenant.id),
  ]);

  const initialContacts: ContactListItem[] = contactsResult.ok ? (contactsResult.data.items as ContactListItem[]) : [];
  const initialNextCursor = contactsResult.ok ? contactsResult.data.nextCursor : null;
  const professionals = professionalsResult.ok ? (professionalsResult.data as ProfessionalRow[]) : [];
  const services = servicesResult.ok ? (servicesResult.data as ServiceRow[]) : [];

  return (
    <ClientesClient
      tenantSlug={tenantSlug}
      timezone={tenant.timezone}
      notifyClient={tenant.notifyClientOnStaffChanges}
      isOwner={membership?.role === "OWNER"}
      writeBlocked={writeBlocked}
      initialContacts={initialContacts}
      initialNextCursor={initialNextCursor}
      initialLoadError={contactsResult.ok ? null : contactsResult.error.message}
      professionals={professionals}
      services={services}
    />
  );
}
