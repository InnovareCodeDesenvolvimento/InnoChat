"use client";

import Link from "next/link";
import { cn } from "@/components/lib/cn";
import { formatRelativeTime, handoffBody, isOffHoursHandoff, notificationHref } from "./notification-utils";
import { FALLBACK_ICON, ICON_BY_KIND, SEVERITY_TONE, SOURCE_VISUAL } from "./notification-visuals";
import { Building2, Moon } from "lucide-react";
import type { BellNotification } from "./types";

/**
 * Uma linha da lista. Com `href` é um link de verdade (abre em nova aba, tem URL no hover);
 * sem `href` é só um botão que marca como lida. Não lida = ponto + fundo levemente tingido; o
 * estado também sai em texto para leitor de tela (`sr-only`), nunca só por cor.
 */
export function NotificationItem({
  notification,
  now,
  onActivate,
}: {
  notification: BellNotification;
  now: Date;
  onActivate: (notification: BellNotification) => void;
}) {
  const Icon = ICON_BY_KIND[notification.kind] ?? FALLBACK_ICON;
  // Tenant: origem (WhatsApp/Painel/Sistema). Admin: a empresa a que o aviso se refere.
  const origin =
    "source" in notification
      ? SOURCE_VISUAL[notification.source]
      : notification.tenant
        ? { icon: Building2, label: notification.tenant.name }
        : null;
  const SourceIcon = origin?.icon;

  const className = cn(
    "flex min-h-[44px] w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 motion-reduce:transition-none",
    "hover:bg-bg focus-visible:bg-bg focus-visible:outline-offset-[-2px]",
    !notification.read && "bg-primary/5",
  );

  const content = (
    <>
      <span
        className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full", SEVERITY_TONE[notification.severity])}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className={cn("text-sm text-text", notification.read ? "font-medium" : "font-semibold")}>
            {!notification.read ? <span className="sr-only">Não lida: </span> : null}
            {notification.title}
          </span>
          {!notification.read ? (
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
          ) : null}
        </span>
        {handoffBody(notification) ? (
          <span className="mt-0.5 line-clamp-2 block break-words text-sm text-text-secondary">{handoffBody(notification)}</span>
        ) : null}
        {isOffHoursHandoff(notification) ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning">
            <Moon className="h-3 w-3 shrink-0" aria-hidden="true" />
            Fora do horário
          </span>
        ) : null}
        <span className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
          <span className="tabular-nums">{formatRelativeTime(notification.createdAt, now)}</span>
          {origin && SourceIcon ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex min-w-0 items-center gap-1">
                <SourceIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{origin.label}</span>
              </span>
            </>
          ) : null}
        </span>
      </span>
    </>
  );

  return (
    <li>
      {notificationHref(notification) ? (
        <Link href={notificationHref(notification) ?? "#"} className={className} onClick={() => onActivate(notification)}>
          {content}
        </Link>
      ) : (
        <button type="button" className={className} onClick={() => onActivate(notification)}>
          {content}
        </button>
      )}
    </li>
  );
}
