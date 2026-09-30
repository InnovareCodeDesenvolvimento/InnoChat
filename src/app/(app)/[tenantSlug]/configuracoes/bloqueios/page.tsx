import { notFound } from "next/navigation";
import { CalendarOff } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { getPrisma } from "@/lib/db/prisma";
import { listScheduleExceptionsAction } from "@/modules/agenda/catalog-actions";
import { isTenantWriteBlocked } from "../../_lib/write-blocked";
import { BloqueiosClient, type CompanyExceptionRow } from "./bloqueios-client";

/**
 * Bloqueio/feriado da empresa inteira (achado da Íris): `ScheduleException` com
 * `professionalId: null` afeta todos os profissionais de uma vez — diferente dos bloqueios por
 * profissional (tela Profissionais > detalhe), que só afetam um. Reaproveita a mesma action
 * (`createScheduleExceptionAction`/`listScheduleExceptionsAction`/`deleteScheduleExceptionAction`),
 * só filtrando `professionalId === null` nesta tela.
 */
export default async function BloqueiosPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, timezone: true } });
  if (!tenant) {
    notFound();
  }

  const result = await listScheduleExceptionsAction(tenantSlug);
  if (!result.ok) {
    return (
      <div>
        <PageHeader help="pagina.bloqueios" icon={navIconFor("configuracoes")} title="Bloqueios e feriados" description="Períodos em que a empresa inteira não atende." />
        <EmptyState icon={CalendarOff} title="Não deu para carregar" description={result.error.message} />
      </div>
    );
  }

  const all = result.data as {
    id: string;
    professionalId: string | null;
    type: "BLOCK" | "HOLIDAY";
    startsAt: string | Date;
    endsAt: string | Date;
    reason: string | null;
  }[];

  const companyExceptions: CompanyExceptionRow[] = all
    .filter((exc) => exc.professionalId === null)
    .map((exc) => ({
      id: exc.id,
      type: exc.type,
      startsAt: new Date(exc.startsAt).toISOString(),
      endsAt: new Date(exc.endsAt).toISOString(),
      reason: exc.reason,
    }));

  const writeBlocked = await isTenantWriteBlocked(tenant.id);

  return (
    <BloqueiosClient
      tenantSlug={tenantSlug}
      timezone={tenant.timezone}
      initialExceptions={companyExceptions}
      writeBlocked={writeBlocked}
    />
  );
}
