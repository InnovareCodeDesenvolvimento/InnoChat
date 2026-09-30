import Link from "next/link";
import { CalendarCheck, CalendarClock, Clock, MessageCircle, MessageCircleWarning, Plus, type LucideIcon } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { PageHeader } from "@/components/ui/page-header";
import { badgeVariants, type BadgeVariants } from "@/components/ui/badge.variants";
import { navIconFor } from "@/components/shell/nav-items";
import { cn } from "@/components/lib/cn";
import { formatDateTimeShortLabel, formatLongDateLabel, formatTimeLabel } from "@/components/lib/format-date";
import { firstNameFromEmail, firstNameOf, greetingAt } from "@/components/lib/greeting";

export type InicioHeaderProps = {
  tenantSlug: string;
  timezone: string;
  userEmail: string | null;
  /** `User.name`; quando existe manda na saudação, senão vale o e-mail. */
  userName?: string | null;
  appointmentsToday: number;
  nextAppointment: { startsAt: string; contactName: string | null; serviceName: string } | null;
  connectedWhatsappCount: number;
  totalWhatsappCount: number;
  /** Só quando a assinatura está em teste e há data de fim. */
  trialEndsAt: string | null;
  /** Instante de referência — injetável para o teste/visual ficar determinístico. */
  now?: Date;
};

function trialLabel(trialEndsAt: string, now: Date): string {
  const hours = Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - now.getTime()) / (60 * 60 * 1000)));
  if (hours >= 48) return `Teste termina em ${Math.ceil(hours / 24)} dias`;
  if (hours <= 1) return "Teste termina em menos de 1h";
  return `Teste termina em ${hours}h`;
}

/**
 * Chip de informação do cabeçalho. Com `href` vira link; a área de toque é estendida para 44px de
 * altura por um pseudo-elemento (o pill continua compacto, o alvo não).
 */
function Chip({
  icon: Icon,
  variant = "neutral",
  href,
  children,
}: {
  icon: LucideIcon;
  variant?: NonNullable<BadgeVariants["variant"]>;
  href?: string;
  children: React.ReactNode;
}) {
  const className = cn(
    badgeVariants({ variant }),
    "max-w-full gap-1.5 px-3 py-1 text-sm",
    href &&
      "relative transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary " +
        "after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']",
  );
  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <span className={className}>{content}</span>
  );
}

/**
 * Cabeçalho do "Início": saudação pelo horário NO FUSO da empresa + primeiro nome, data por
 * extenso e chips com informação real (agenda de hoje, próximo atendimento, estado do
 * WhatsApp/bot, fim do teste). Nada inventado — tudo vem do que a página já carrega.
 */
export function InicioHeader({
  tenantSlug,
  timezone,
  userEmail,
  userName = null,
  appointmentsToday,
  nextAppointment,
  connectedWhatsappCount,
  totalWhatsappCount,
  trialEndsAt,
  now = new Date(),
}: InicioHeaderProps) {
  const greeting = greetingAt(now, timezone);
  const name = firstNameOf(userName) ?? firstNameFromEmail(userEmail);
  const todayISO = formatInTimeZone(now, timezone, "yyyy-MM-dd");

  let nextLabel: string | null = null;
  if (nextAppointment) {
    const sameDay = formatInTimeZone(new Date(nextAppointment.startsAt), timezone, "yyyy-MM-dd") === todayISO;
    const when = sameDay
      ? formatTimeLabel(nextAppointment.startsAt, timezone)
      : formatDateTimeShortLabel(nextAppointment.startsAt, timezone);
    nextLabel = `Próximo: ${when} com ${nextAppointment.contactName ?? "cliente sem nome"}, ${nextAppointment.serviceName}`;
  }

  const whatsappHref = `/${tenantSlug}/whatsapp`;

  return (
    <PageHeader help="pagina.inicio"
      icon={navIconFor("inicio")}
      size="hero"
      title={
        <>
          {greeting}
          {name ? `, ${name}` : "!"} <span aria-hidden="true">👋</span>
        </>
      }
      description={
        <>
          <span className="block">{formatLongDateLabel(todayISO)}</span>
          <span className="mt-3 flex flex-wrap gap-x-2 gap-y-3" data-testid="inicio-chips">
            <Chip icon={appointmentsToday > 0 ? CalendarCheck : CalendarClock} variant="primary">
              {appointmentsToday > 0 ? (
                <>
                  <strong className="font-bold">{appointmentsToday}</strong>{" "}
                  {appointmentsToday === 1 ? "atendimento hoje" : "atendimentos hoje"}
                </>
              ) : (
                "Agenda livre hoje"
              )}
            </Chip>
            {nextLabel ? <Chip icon={Clock}>{nextLabel}</Chip> : null}
            {connectedWhatsappCount > 0 ? (
              <Chip icon={MessageCircle} variant="success" href={whatsappHref}>
                Bot ativo no WhatsApp
              </Chip>
            ) : (
              <Chip icon={MessageCircleWarning} variant="warning" href={whatsappHref}>
                {totalWhatsappCount === 0 ? "Conecte seu WhatsApp" : "WhatsApp desconectado"}
              </Chip>
            )}
            {trialEndsAt ? (
              <Chip icon={Clock} variant="warning" href={`/${tenantSlug}/assinatura`}>
                {trialLabel(trialEndsAt, now)}
              </Chip>
            ) : null}
          </span>
        </>
      }
      action={
        <Link
          href={`/${tenantSlug}/agenda`}
          className="inline-flex h-11 items-center gap-2 rounded-card bg-primary px-4 text-sm font-medium text-white transition-transform duration-150 hover:bg-primary-strong active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Novo agendamento
        </Link>
      }
    />
  );
}
