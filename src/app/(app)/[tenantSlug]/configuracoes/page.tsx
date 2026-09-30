import { notFound } from "next/navigation";
import { Palette, Building2, Clock, Users2, CalendarOff } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { getPrisma } from "@/lib/db/prisma";
import { auth } from "@/lib/auth";
import { ConfiguracoesGrid, type ConfigSection } from "./configuracoes-grid";
import { EmpresaDocumentForm } from "./empresa-document-form";
import { LembreteCard } from "./lembrete-card";
import { AtendimentoCard } from "./atendimento-card";
import { Alert } from "@/components/ui/alert";
import { isTenantWriteBlocked } from "../_lib/write-blocked";
import { getReminderSettingsAction } from "@/modules/reminders/actions";
import { getBotRulesAction } from "@/modules/tenant/actions";

const SECTIONS: ConfigSection[] = [
  {
    href: "aparencia",
    help: "pagina.aparencia",
    icon: <Palette aria-hidden="true" />,
    title: "Aparência",
    description: "Escolha o tema visual do painel da sua empresa.",
    ready: true,
  },
  {
    href: "empresa",
    icon: <Building2 aria-hidden="true" />,
    title: "Empresa",
    description: "Nome, segmento e fuso horário.",
    ready: false,
  },
  {
    href: "agenda",
    icon: <Clock aria-hidden="true" />,
    title: "Regras de agenda e do bot",
    description: "Antecedência mínima, horizonte máximo, timeout da sessão.",
    ready: false,
  },
  {
    href: "bloqueios",
    help: "pagina.bloqueios",
    icon: <CalendarOff aria-hidden="true" />,
    title: "Bloqueios e feriados",
    description: "Períodos em que a empresa inteira não atende, para todos os profissionais.",
    ready: true,
  },
  {
    href: "equipe",
    help: "pagina.equipe",
    icon: <Users2 aria-hidden="true" />,
    title: "Equipe",
    description: "Convide colegas para o painel.",
    ready: true,
  },
];

export default async function ConfiguracoesPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  const tenant = await getPrisma().tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, document: true },
  });
  if (!tenant) {
    notFound();
  }

  const session = await auth();
  const membership = session?.user?.id
    ? await getPrisma().membership.findFirst({
        where: { userId: session.user.id, tenantId: tenant.id },
        select: { role: true },
      })
    : null;

  const [reminder, botRules, writeBlocked] = await Promise.all([
    getReminderSettingsAction({ tenantSlug }),
    getBotRulesAction(tenantSlug),
    isTenantWriteBlocked(tenant.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader help="pagina.configuracoes" icon={navIconFor("configuracoes")} title="Configurações" description="Empresa, regras de agenda e do bot, equipe." />

      <EmpresaDocumentForm
        tenantSlug={tenantSlug}
        currentDocument={tenant.document}
        isOwner={membership?.role === "OWNER"}
      />

      {reminder.ok ? (
        <LembreteCard
          tenantSlug={tenantSlug}
          initial={reminder.data}
          isOwner={membership?.role === "OWNER"}
          writeBlocked={writeBlocked}
        />
      ) : (
        <Alert variant="danger" title="Não deu para carregar o lembrete automático">
          {reminder.error.message} Recarregue a página para tentar de novo.
        </Alert>
      )}

      {botRules.ok ? (
        <AtendimentoCard
          tenantSlug={tenantSlug}
          initial={botRules.data}
          isOwner={membership?.role === "OWNER"}
          writeBlocked={writeBlocked}
        />
      ) : (
        <Alert variant="danger" title="Não deu para carregar as regras do atendimento">
          {botRules.error.message} Recarregue a página para tentar de novo.
        </Alert>
      )}

      <ConfiguracoesGrid tenantSlug={tenantSlug} sections={SECTIONS} />
    </div>
  );
}
