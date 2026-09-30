import { MessageCircle } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getPrisma } from "@/lib/db/prisma";
import { auth } from "@/lib/auth";
import { getWhatsappPageExtrasAction, listWhatsappInstancesAction } from "@/modules/whatsapp/actions";
import { isTenantWriteBlocked } from "../_lib/write-blocked";
import { WhatsappClient } from "./whatsapp-client";

export default async function WhatsappPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const [result, extrasResult] = await Promise.all([
    listWhatsappInstancesAction(tenantSlug),
    getWhatsappPageExtrasAction({ tenantSlug }),
  ]);

  if (!result.ok) {
    return (
      <div>
        <PageHeader help="pagina.whatsapp" icon={navIconFor("whatsapp")} title="WhatsApp" description="Números conectados, QR code e status da conexão." />
        <EmptyState icon={MessageCircle} title="Não deu para carregar os números" description={result.error.message} />
      </div>
    );
  }

  const [tenant, session] = await Promise.all([
    getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, timezone: true } }),
    auth(),
  ]);

  const [writeBlocked, membership] = await Promise.all([
    tenant ? isTenantWriteBlocked(tenant.id) : Promise.resolve(false),
    session?.user?.id
      ? getPrisma().membership.findFirst({
          where: { userId: session.user.id, tenant: { slug: tenantSlug } },
          select: { role: true },
        })
      : Promise.resolve(null),
  ]);

  return (
    <WhatsappClient
      tenantSlug={tenantSlug}
      timezone={tenant?.timezone ?? "America/Sao_Paulo"}
      initialInstances={result.data}
      isOwner={membership?.role === "OWNER"}
      writeBlocked={writeBlocked}
      // Extras são "melhor esforço": se falharem, a tela segue sem prévia real e sem card de limite.
      extras={extrasResult.ok ? extrasResult.data : null}
    />
  );
}
