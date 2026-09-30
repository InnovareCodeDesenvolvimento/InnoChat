"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { FALLBACK_ICON, ICON_BY_KIND, SEVERITY_TONE } from "./notification-visuals";
import { notificationHref } from "./notification-utils";
import type { BellNotification } from "./types";

const TOAST_DURATION_MS = 8000;

function NotificationToast({
  notification,
  onDismiss,
  onView,
}: {
  notification: BellNotification;
  onDismiss: (id: string) => void;
  onView: (notification: BellNotification) => void;
}) {
  const [paused, setPaused] = useState(false);
  const Icon = ICON_BY_KIND[notification.kind] ?? FALLBACK_ICON;

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(notification.id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [paused, notification.id, onDismiss]);

  return (
    <div
      className={cn(
        "notif-toast pointer-events-auto flex items-start gap-3 rounded-card border border-border bg-surface p-3 shadow-card-hover",
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", SEVERITY_TONE[notification.severity])}>
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">{notification.title}</p>
        {notification.body ? <p className="mt-0.5 line-clamp-2 text-sm text-text-secondary">{notification.body}</p> : null}
        {notificationHref(notification) ? (
          <Link
            href={notificationHref(notification) ?? "#"}
            onClick={() => onView(notification)}
            className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium text-primary hover:underline sm:min-h-[32px]"
          >
            Ver
          </Link>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(notification.id)}
        className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-card text-text-secondary transition-colors duration-150 hover:bg-bg motion-reduce:transition-none"
        aria-label="Dispensar aviso"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Avisos discretos de notificações novas (máx. 3 — o limite é aplicado em `pickToasts`). Fica em
 * `document.body` via portal porque a topbar tem `backdrop-filter`, que prende filhos `fixed`
 * dentro dela. Região `aria-live="polite"`: o leitor de tela anuncia sem interromper.
 */
export function NotificationToasts({
  toasts,
  onDismiss,
  onView,
}: {
  toasts: BellNotification[];
  onDismiss: (id: string) => void;
  onView: (notification: BellNotification) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(timer);
  }, []);
  if (!mounted) return null;

  return createPortal(
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-4 top-[4.5rem] z-[90] flex flex-col gap-2 sm:left-auto sm:right-6 sm:w-[24rem]"
    >
      {toasts.map((notification) => (
        <NotificationToast key={notification.id} notification={notification} onDismiss={onDismiss} onView={onView} />
      ))}
    </div>,
    document.body,
  );
}
