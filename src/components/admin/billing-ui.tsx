import { Mail, MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { HelpButton } from "@/components/help/help-button";
import type { HelpKey } from "@/components/help/help-content";
import { cn } from "@/components/lib/cn";
import { NOTICE_STATUS_VARIANT, type NoticeChannel, type NoticeStatus } from "./billing-types";
import { noticeStatusLabel } from "@/core/billing/dunning-labels";

/** Ícone do canal com nome acessível ("E-mail" / "WhatsApp"); o texto também aparece em telas largas quando `showLabel`. */
export function ChannelIcon({ channel, showLabel = false, className }: { channel: NoticeChannel; showLabel?: boolean; className?: string }) {
  const Icon = channel === "EMAIL" ? Mail : MessageCircle;
  const label = channel === "EMAIL" ? "E-mail" : "WhatsApp";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-text-secondary", className)}>
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          channel === "EMAIL" ? "bg-primary/10 text-primary" : "bg-success-bg text-success",
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      {showLabel ? <span className="text-xs font-medium">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}

export function NoticeStatusBadge({ status, label }: { status: NoticeStatus | (string & {}); label?: string }) {
  return <Badge variant={NOTICE_STATUS_VARIANT[status as NoticeStatus] ?? "neutral"}>{label || noticeStatusLabel(status)}</Badge>;
}

const TONE: Record<"primary" | "success" | "warning" | "danger", string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};

/** Cartão de número com selo, ajuda ⓘ e linhas de detalhe. Sem animação: serve a Server Components (o ícone chega já renderizado). */
export function BillingStatCard({
  icon,
  label,
  value,
  tone = "primary",
  help,
  children,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  tone?: keyof typeof TONE;
  help?: HelpKey;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("relative overflow-hidden rounded-hero p-5", className)}>
      <div className="pointer-events-none absolute -right-3 -top-3 text-text opacity-[0.07] [&>svg]:h-24 [&>svg]:w-24" aria-hidden="true">
        {icon}
      </div>
      {help ? <HelpButton helpKey={help} placement="corner" /> : null}
      <div className={cn("mb-4 flex h-11 w-11 items-center justify-center rounded-full [&>svg]:h-5 [&>svg]:w-5", TONE[tone])}>{icon}</div>
      <p className="pr-8 text-sm font-medium text-text-secondary">{label}</p>
      {value ? <p className="mt-1 font-display text-3xl font-black tabular-nums text-text">{value}</p> : null}
      {children}
    </Card>
  );
}
