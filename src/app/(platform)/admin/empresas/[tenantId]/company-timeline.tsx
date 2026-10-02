"use client";

import { useRouter, usePathname } from "next/navigation";
import { useTransition } from "react";
import {
  ArrowRightLeft,
  Ban,
  CheckCircle2,
  FileText,
  Layers,
  QrCode,
  RotateCcw,
  Timer,
  UserX,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Pagination } from "@/components/ui/pagination";
import { DEFAULT_PAGE_SIZE } from "@/components/lib/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/components/lib/cn";
import { formatTimeLabel } from "@/components/lib/format-date";
import { ChannelIcon, NoticeStatusBadge } from "@/components/admin/billing-ui";
import { skippedReasonLabel } from "@/core/billing/dunning-labels";
import type { TimelineItem } from "@/components/admin/billing-types";
import { formatDateBR } from "@/modules/billing/format";

const TZ = "America/Sao_Paulo";

type Tone = "primary" | "success" | "warning" | "danger" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  neutral: "bg-bg text-text-secondary",
};

const EVENT_ICON: Record<string, LucideIcon> = {
  STATUS_CHANGED: ArrowRightLeft,
  INVOICE_CREATED: FileText,
  PAYMENT_CONFIRMED: CheckCircle2,
  PIX_REGENERATED: QrCode,
  PLAN_CHANGED: Layers,
  CANCEL_REQUESTED: UserX,
  CANCEL_UNDONE: RotateCcw,
  REACTIVATION_STARTED: RotateCcw,
  MANUAL_PAYMENT: CheckCircle2,
  MANUAL_SUSPEND: Ban,
  MANUAL_REACTIVATE: RotateCcw,
  TRIAL_EXTENDED: Timer,
  NOTICE_RESENT: RotateCcw,
};

function eventTone(type: string | null | undefined, to: string | null | undefined): Tone {
  if (type === "PAYMENT_CONFIRMED" || type === "MANUAL_PAYMENT" || type === "MANUAL_REACTIVATE" || type === "REACTIVATION_STARTED" || type === "CANCEL_UNDONE") {
    return "success";
  }
  if (type === "MANUAL_SUSPEND" || type === "CANCEL_REQUESTED") return "danger";
  if (type === "STATUS_CHANGED") {
    if (to === "SUSPENDED" || to === "CANCELED") return "danger";
    if (to === "PAST_DUE") return "warning";
    if (to === "ACTIVE") return "success";
  }
  return "primary";
}

function Entry({ item }: { item: TimelineItem }) {
  const when = new Date(item.at);
  let marker: React.ReactNode;
  let extra: React.ReactNode = null;

  if (item.kind === "NOTICE") {
    marker = item.channel ? (
      <ChannelIcon channel={item.channel} className="[&>span:first-child]:h-9 [&>span:first-child]:w-9 [&_svg]:h-4 [&_svg]:w-4" />
    ) : (
      <span className={cn("flex h-9 w-9 items-center justify-center rounded-full", TONE_CLASS.neutral)}>
        <FileText className="h-4 w-4" aria-hidden="true" />
      </span>
    );
    extra = (
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
        {item.status ? <NoticeStatusBadge status={item.status} /> : null}
        {item.recipient ?? item.recipientMasked ? <span className="break-all">Para {item.recipient ?? item.recipientMasked}</span> : null}
        {item.attempts && item.attempts > 1 ? <span>{item.attempts} tentativas</span> : null}
        {item.status === "SKIPPED" && item.skipReason ? <span>Motivo: {skippedReasonLabel(item.skipReason)}</span> : null}
      </div>
    );
  } else {
    const Icon = (item.type ? EVENT_ICON[item.type] : undefined) ?? XCircle;
    marker = (
      <span className={cn("flex h-9 w-9 items-center justify-center rounded-full", TONE_CLASS[eventTone(item.type, item.to)])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  }

  return (
    <li className="relative flex gap-3 pb-6 last:pb-0" data-kind={item.kind}>
      <span aria-hidden="true" className="absolute bottom-0 left-[17px] top-9 w-px bg-border last:hidden" />
      <div className="relative shrink-0">{marker}</div>
      <div className="min-w-0 flex-1 pt-1">
        <p className="text-sm font-medium text-text">{item.label}</p>
        {extra}
        <p className="mt-1 text-xs tabular-nums text-text-secondary">
          {formatDateBR(when, TZ)} às {formatTimeLabel(when, TZ)}
        </p>
      </div>
    </li>
  );
}

export type TimelinePageData = { items: TimelineItem[]; page: number; pageSize: number; totalItems: number; totalPages: number };

export function CompanyTimeline({ data }: { data: TimelinePageData }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const { items, page, pageSize } = data;

  function go(nextPage: number, nextSize: number) {
    const q = new URLSearchParams();
    if (nextPage > 1) q.set("pagina", String(nextPage));
    if (nextSize !== DEFAULT_PAGE_SIZE) q.set("porPagina", String(nextSize));
    const text = q.toString();
    startTransition(() => router.push(`${pathname}${text ? `?${text}` : ""}`, { scroll: false }));
  }

  if (items.length === 0 && data.totalItems === 0) {
    return <EmptyState title="Nada na cobrança ainda" description="Os avisos enviados e as mudanças na assinatura aparecem aqui." />;
  }

  return (
    <div>
      <div className={isPending ? "opacity-60 transition-opacity" : "transition-opacity"}>
        <ol aria-label="Linha do tempo da cobrança">
          {items.map((item, i) => (
            <Entry key={item.id ?? `${item.kind}-${item.at}-${i}`} item={item} />
          ))}
        </ol>
      </div>
      <Pagination
        className="mt-6 border-t border-border pt-4"
        label="Paginação da linha do tempo"
        page={page}
        pageSize={pageSize}
        totalItems={data.totalItems}
        totalPages={data.totalPages}
        isPending={isPending}
        onPageChange={(p) => go(p, pageSize)}
        onPageSizeChange={(size) => go(1, size)}
      />
    </div>
  );
}
