"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { AlertTriangle, CalendarCheck, Clock, Lock, QrCode, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/help/help-button";
import { cn } from "@/components/lib/cn";
import { formatCountdown, type BillingBannerState } from "./billing-banner-state";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Relógio do contador. Começa no instante em que o SERVIDOR calculou o estado (`serverNowMs`), para
 * o primeiro render do cliente sair igual ao do servidor (sem erro de hidratação) e anda a cada
 * 30 s. Quando o contador chega a zero, pede um `router.refresh()` (uma vez) para o servidor
 * recalcular o estado em vez de ficar mostrando "agora" para sempre.
 */
function useCountdownClock(serverNowMs: number, targetMs: number | null): number {
  const router = useRouter();
  const [now, setNow] = useState(serverNowMs);
  const refreshed = useRef(false);

  useEffect(() => {
    // Hidratou: o relógio real do navegador assume (sem `setState` síncrono no corpo do efeito).
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (targetMs !== null && now >= targetMs && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [now, targetMs, router]);

  return now;
}

const DISMISS_EVENT = "innochat:banner-dismiss";

function subscribeDismiss(callback: () => void): () => void {
  window.addEventListener(DISMISS_EVENT, callback);
  return () => window.removeEventListener(DISMISS_EVENT, callback);
}

/** Dispensa por sessão do navegador (volta ao abrir outra aba/sessão). Servidor: já dispensado,
 * para o aviso só nascer depois da hidratação e nunca "piscar" para quem já fechou. */
export function useSessionDismiss(key: string): [dismissed: boolean, dismiss: () => void] {
  const dismissed = useSyncExternalStore(
    subscribeDismiss,
    () => {
      try {
        return window.sessionStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    () => true,
  );
  function dismiss() {
    try {
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Sem sessionStorage (modo restrito): fecha só até o próximo evento de render.
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }
  return [dismissed, dismiss];
}

type BannerShellProps = {
  tone: "neutral" | "warning" | "danger" | "success";
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
  helpKey?: "assinatura.banner";
  testId: string;
  onDismiss?: () => void;
};

const TONE_CLASS: Record<BannerShellProps["tone"], string> = {
  neutral: "border-border bg-bg text-text",
  warning: "border-warning/30 bg-warning-bg text-warning",
  danger: "border-danger/30 bg-danger-bg text-danger",
  success: "border-success/30 bg-success-bg text-success",
};

function BannerShell({ tone, icon, children, action, helpKey, testId, onDismiss }: BannerShellProps) {
  return (
    <div
      data-testid={testId}
      className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2 text-sm sm:px-6", TONE_CLASS[tone])}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 basis-64">
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0">{children}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {action}
        {helpKey ? <HelpButton helpKey={helpKey} placement="inline" /> : null}
        {onDismiss ? (
          <Button type="button" variant="ghost" size="icon" aria-label="Dispensar este aviso" onClick={onDismiss}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export function payHref(tenantSlug: string): string {
  return `/${tenantSlug}/assinatura?pagar=pix#pix`;
}

function PayButton({ href, label, variant }: { href: string; label: string; variant: "primary" | "danger" }) {
  return (
    <Button asChild size="sm" variant={variant}>
      <Link href={href}>
        <QrCode className="h-4 w-4" aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}

/**
 * Banner global de cobrança (docs/regua-de-cobranca.md §2.2 coluna B). Só desenha: o estado vem do
 * servidor (`resolveBillingBanner`) e o servidor continua sendo quem bloqueia escrita quando a
 * assinatura está suspensa (`assertTenantCanWrite`). Fica no fluxo da página, entre a topbar e o
 * conteúdo, então nunca cobre nada nem disputa espaço com o selo flutuante e o botão do tour.
 */
export function SubscriptionBanner({
  tenantSlug,
  timezone,
  state,
  serverNowMs,
}: {
  tenantSlug: string;
  timezone: string;
  state: BillingBannerState | null;
  serverNowMs: number;
}) {
  const target =
    state?.kind === "TRIAL"
      ? state.endsAt
      : state?.kind === "INVOICE_DUE"
        ? state.dueAt
        : state?.kind === "GRACE"
          ? state.stopsAt
          : state?.kind === "SUSPENDED"
            ? state.cancelsAt
            : null;
  const targetMs = target ? new Date(target).getTime() : null;
  const now = useCountdownClock(serverNowMs, targetMs);
  const [renewedDismissed, dismissRenewed] = useSessionDismiss(`innochat:renewed-dismissed:${tenantSlug}`);

  if (!state) return null;
  const href = payHref(tenantSlug);
  const left = targetMs !== null ? formatCountdown(targetMs, now) : null;
  const within24h = targetMs !== null && targetMs - now <= 24 * 60 * 60 * 1000;

  if (state.kind === "TRIAL") {
    return (
      <BannerShell
        testId="billing-banner-trial"
        tone={within24h ? "warning" : "neutral"}
        icon={<Clock className={cn("h-4 w-4", within24h ? "" : "text-primary")} />}
        helpKey="assinatura.banner"
        action={<PayButton href={href} label="Assinar com Pix" variant="primary" />}
      >
        Seu teste termina em <strong className="tabular-nums">{left}</strong>.
      </BannerShell>
    );
  }

  if (state.kind === "INVOICE_DUE") {
    return (
      <BannerShell
        testId="billing-banner-invoice"
        tone="warning"
        icon={<AlertTriangle className="h-4 w-4" />}
        helpKey="assinatura.banner"
        action={<PayButton href={href} label="Pagar com Pix" variant="primary" />}
      >
        Sua fatura de {BRL.format(state.amountCents / 100)} vence em <strong className="tabular-nums">{left}</strong> (
        {formatInTimeZone(new Date(state.dueAt), timezone, "dd/MM")}).
      </BannerShell>
    );
  }

  if (state.kind === "GRACE") {
    return (
      <BannerShell
        testId="billing-banner-grace"
        tone="danger"
        icon={<AlertTriangle className="h-4 w-4" />}
        helpKey="assinatura.banner"
        action={<PayButton href={href} label="Pagar com Pix" variant="danger" />}
      >
        Fatura vencida. O bot para de responder em <strong className="tabular-nums">{left}</strong>.
      </BannerShell>
    );
  }

  if (state.kind === "SUSPENDED") {
    return (
      <BannerShell
        testId="billing-banner-suspended"
        tone="danger"
        icon={<Lock className="h-4 w-4" />}
        helpKey="assinatura.banner"
        action={<PayButton href={href} label="Pagar e reativar" variant="danger" />}
      >
        Assinatura suspensa: o painel está só para consulta e o bot está mudo.
        {" "}
        A conta é encerrada em <strong className="tabular-nums">{left}</strong>.
      </BannerShell>
    );
  }

  if (state.kind === "CANCELED") {
    return (
      <BannerShell
        testId="billing-banner-canceled"
        tone="danger"
        icon={<Lock className="h-4 w-4" />}
        action={
          <Button asChild size="sm" variant="danger">
            <Link href={`/${tenantSlug}/assinatura`}>Reativar</Link>
          </Button>
        }
      >
        Assinatura cancelada: o painel mostra só a tela de Assinatura e o bot está mudo.
      </BannerShell>
    );
  }

  // RENEWED
  if (renewedDismissed) return null;
  return (
    <BannerShell
      testId="billing-banner-renewed"
      tone="success"
      icon={<CalendarCheck className="h-4 w-4" />}
      helpKey="assinatura.banner"
      onDismiss={dismissRenewed}
    >
      Assinatura renovada até {formatInTimeZone(new Date(state.until), timezone, "dd/MM")}. Obrigado!
    </BannerShell>
  );
}
