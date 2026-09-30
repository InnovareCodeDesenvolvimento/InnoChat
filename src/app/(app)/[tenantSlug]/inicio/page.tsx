import { cache, Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { CalendarClock, CalendarPlus, CalendarRange, MessageCircle, Percent, Scissors, UserX, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { CalendarEmptyIllustration } from "@/components/ui/empty-illustration";
import { cn } from "@/components/lib/cn";
import { Skeleton } from "@/components/ui/skeleton";
import { DomainError } from "@/lib/errors";
import { effectiveStatus } from "@/core/billing";
import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/db/prisma";
import { requireTenantMember } from "@/lib/auth/guards";
import { getSubscriptionSnapshot } from "@/modules/billing/service";
import { getDashboardView } from "@/modules/dashboard/queries";
import { UpcomingTodayCard } from "@/components/notifications/upcoming-today-card";
import { InicioChart } from "./inicio-chart";
import { InicioHeader, type InicioHeaderProps } from "./inicio-header";
import { OnboardingChecklistCard } from "@/components/onboarding/onboarding-checklist-card";
import { getOnboardingStateAction } from "@/modules/onboarding/actions";

/**
 * Página "Início" (docs/design/premium-spec.md §10) — a leitura de dados vem inteira de
 * `src/modules/dashboard/queries.ts` (exceção de escopo autorizada pelo Atlas: só leitura,
 * escopo por tenant). Erro de leitura vira mensagem explícita, nunca uma página em branco.
 *
 * `Suspense` em volta de `InicioContent` (pacote "movimento e carregamento", 2026-09-29): dá um
 * skeleton com shimmer de verdade durante a navegação/streaming, em vez de só aparecer tudo de
 * uma vez quando o Server Component termina — o cabeçalho e o botão de ação já aparecem na hora.
 */
export default async function InicioPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;

  return (
    <div>
      <Suspense fallback={<InicioHeaderSkeleton />}>
        <InicioHeaderLoader tenantSlug={tenantSlug} />
      </Suspense>
      <Suspense fallback={null}>
        <InicioChecklist tenantSlug={tenantSlug} />
      </Suspense>
      <Suspense fallback={<InicioSkeleton />}>
        <InicioContent tenantSlug={tenantSlug} />
      </Suspense>
    </div>
  );
}

/** Uma leitura só por requisição: cabeçalho e conteúdo compartilham o resultado (`cache` do React). */
const loadDashboard = cache((tenantSlug: string) => getDashboardView(tenantSlug));

/**
 * Cabeçalho com saudação e chips. Se a leitura falhar, cai no título simples "Início" — o erro em
 * si é mostrado por `InicioContent`; o cabeçalho nunca derruba a página.
 */
async function InicioHeaderLoader({ tenantSlug }: { tenantSlug: string }) {
  let props: InicioHeaderProps | null = null;
  try {
    const [view, session, tenantCtx] = await Promise.all([
      loadDashboard(tenantSlug),
      auth(),
      requireTenantMember(tenantSlug),
    ]);
    const now = new Date();
    // Nome de exibição (Minha conta); falhar aqui só faz a saudação cair no e-mail.
    const userName = session?.user?.id
      ? ((await getPrisma().user.findUnique({ where: { id: session.user.id }, select: { name: true } }))?.name ?? null)
      : null;
    // Fim do teste: só quando a assinatura EFETIVA (pura, `effectiveStatus`) ainda é TRIALING.
    let trialEndsAt: string | null = null;
    try {
      const subscription = await getSubscriptionSnapshot(tenantCtx.tenant.id);
      if (effectiveStatus(subscription, now) === "TRIALING" && subscription.trialEndsAt) {
        trialEndsAt = subscription.trialEndsAt.toISOString();
      }
    } catch {
      trialEndsAt = null;
    }
    const next = view.upcoming[0];
    props = {
      tenantSlug,
      timezone: view.timezone,
      userEmail: session?.user?.email ?? null,
      userName,
      appointmentsToday: view.appointmentsToday,
      nextAppointment: next ? { startsAt: next.startsAt, contactName: next.contactName, serviceName: next.serviceName } : null,
      connectedWhatsappCount: view.connectedWhatsappCount,
      totalWhatsappCount: view.totalWhatsappCount,
      trialEndsAt,
      now,
    };
  } catch {
    props = null;
  }
  if (!props) {
    return <PageHeader help="pagina.inicio" icon={navIconFor("inicio")} size="hero" title="Início" description="O resumo do seu negócio hoje." />;
  }
  return <InicioHeader {...props} />;
}

function InicioHeaderSkeleton() {
  return (
    <div className="mb-6 flex items-start gap-3.5" aria-hidden="true">
      <Skeleton className="hidden h-14 w-14 rounded-card sm:block" />
      <div className="flex-1">
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="mt-3 h-4 w-48" />
        <div className="mt-3 flex gap-2">
          <Skeleton className="h-7 w-32 rounded-full" />
          <Skeleton className="h-7 w-44 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/**
 * Card "Primeiros passos" do Inno. Some (renderiza nada) se o checklist foi escondido ou se a
 * leitura falhar — é um extra de onboarding, nunca pode derrubar nem atrasar o resumo do dia.
 */
async function InicioChecklist({ tenantSlug }: { tenantSlug: string }) {
  const result = await getOnboardingStateAction(tenantSlug);
  if (!result.ok || result.data.checklistDismissedAt) return null;
  return <OnboardingChecklistCard tenantSlug={tenantSlug} state={result.data} />;
}

async function InicioContent({ tenantSlug }: { tenantSlug: string }) {
  let view;
  try {
    view = await loadDashboard(tenantSlug);
  } catch (error) {
    if (error instanceof DomainError && error.code === "NOT_FOUND") {
      notFound();
    }
    return (
      <EmptyState
        title="Não foi possível carregar o resumo agora"
        description="Tente recarregar a página em alguns instantes. Se o problema continuar, fale com o suporte."
      />
    );
  }

  const hasAnyActivity = view.dailySeries.some((p) => p.count > 0) || view.upcoming.length > 0;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          index={0}
          size="hero"
          icon={<CalendarClock aria-hidden="true" strokeWidth={1.5} />}
          label="Agendamentos hoje"
          help="inicio.agendamentosHoje"
          value={view.appointmentsToday}
          tone="primary"
          context="não cancelados"
        />
        <StatCard
          index={1}
          icon={<CalendarRange aria-hidden="true" strokeWidth={1.5} />}
          label="Próximos 7 dias"
          help="inicio.proximos7dias"
          value={view.appointmentsNext7Days}
          tone="primary"
          context="agendamentos previstos"
        />
        <StatCard
          index={2}
          icon={<UserX aria-hidden="true" strokeWidth={1.5} />}
          label="Taxa de faltas"
          help="inicio.taxaFaltas"
          value={view.noShowRatePercent}
          suffix="%"
          tone={view.noShowRatePercent > 20 ? "danger" : "success"}
          context="últimos 30 dias"
        />
        <StatCard
          index={3}
          icon={<Percent aria-hidden="true" strokeWidth={1.5} />}
          label="Agendado pelo bot"
          help="inicio.agendadoPeloBot"
          value={view.botSharePercent}
          suffix="%"
          tone="primary"
          context="últimos 30 dias"
        />
        <StatCard
          index={4}
          icon={<MessageCircle aria-hidden="true" strokeWidth={1.5} />}
          label="WhatsApp conectado"
          help="inicio.whatsappConectado"
          value={view.connectedWhatsappCount}
          tone={view.connectedWhatsappCount > 0 ? "success" : "warning"}
          context={`de ${view.totalWhatsappCount} número(s)`}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="rounded-hero lg:col-span-2">
          <CardHeader help="inicio.grafico">
            <CardTitle>Agendamentos por dia</CardTitle>
          </CardHeader>
          <CardContent>
            {hasAnyActivity ? (
              <InicioChart data={view.dailySeries} />
            ) : (
              <EmptyState
                variant="highlight"
                illustration={<CalendarEmptyIllustration className="h-full w-full" />}
                title="Ainda sem agendamentos no período"
                description="O gráfico aparece assim que os primeiros agendamentos entrarem, pelo painel ou pelo bot."
              />
            )}
          </CardContent>
        </Card>

        <UpcomingTodayCard tenantSlug={tenantSlug} timezone={view.timezone} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ShortcutCard href={`/${tenantSlug}/agenda?novo=1`} icon={CalendarPlus} label="Novo agendamento" />
        <ShortcutCard href={`/${tenantSlug}/clientes?novo=1`} icon={UserPlus} label="Novo cliente" />
        <ShortcutCard href={`/${tenantSlug}/servicos`} icon={Scissors} label="Gerenciar serviços" />
      </div>
    </>
  );
}

function ShortcutCard({ href, icon: Icon, label }: { href: string; icon: typeof CalendarPlus; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-hero border border-border bg-surface p-4 text-sm font-medium text-text",
        "transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover motion-reduce:transition-none motion-reduce:hover:translate-y-0",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      {label}
    </Link>
  );
}

/** Skeleton do "Início" — mesma forma da grade real (5 StatCards + gráfico/lista + atalhos). */
function InicioSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[164px] rounded-hero" />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-[300px] rounded-hero lg:col-span-2" />
        <Skeleton className="h-[300px] rounded-hero" />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[60px] rounded-hero" />
        ))}
      </div>
    </>
  );
}
