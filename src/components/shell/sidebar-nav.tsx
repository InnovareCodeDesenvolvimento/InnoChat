"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { NAV_HOVER_SPRING } from "@/components/lib/motion";
import { useTour } from "@/components/onboarding/onboarding-tour";
import { useAttendanceWaitingCount } from "@/components/notifications/notification-center-provider";
import { badgeText } from "@/components/notifications/notification-utils";
import {
  adminNavGroups,
  tenantNavGroups,
  tenantOnboardingItem,
  type NavGroup,
  type NavItem,
} from "./nav-items";

/**
 * `NavItem[]`/`NavGroup[]` carregam o componente do ícone (lucide-react) como VALOR — passar
 * isso como prop de um Server Component para um Client Component quebra ("Only plain objects
 * can be passed..."), porque um componente React não é serializável através da fronteira
 * servidor/cliente. Por isso os itens nunca vêm de fora: cada variante resolve a própria lista
 * aqui dentro, já no lado do cliente (import direto, não prop).
 */
function isItemActive(item: NavItem, pathname: string | null): boolean {
  return pathname === item.href || !!pathname?.startsWith(`${item.href}/`);
}

function groupContainingActive(groups: NavGroup[], pathname: string | null): string | null {
  return groups.find((g) => g.items.some((item) => isItemActive(item, pathname)))?.id ?? null;
}

function NavRow({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const active = isItemActive(item, pathname);
  const Icon = item.icon;
  const attendanceWaiting = useAttendanceWaitingCount();
  const badgeCount = item.badge === "attendance" ? attendanceWaiting : 0;

  return (
    <motion.div whileHover={reduceMotion ? undefined : { scale: 1.02 }} whileTap={reduceMotion ? undefined : { scale: 0.98 }} transition={NAV_HOVER_SPRING}>
      <Link
        href={item.href}
        data-tour={`nav-${item.href.split("/").pop()}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex min-h-10 items-center gap-2.5 rounded-card px-3 py-2 font-medium text-sidebar-text",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          active ? "bg-sidebar-active text-sidebar-active-text" : "hover:bg-sidebar-hover",
        )}
      >
        {active ? (
          <span
            className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-accent"
            aria-hidden="true"
          />
        ) : null}
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{item.label}</span>
        {badgeCount > 0 ? (
          <>
            <span
              data-testid="nav-badge-attendance"
              aria-hidden="true"
              className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-bold leading-none text-white"
            >
              {badgeText(badgeCount)}
            </span>
            <span className="sr-only">
              {badgeCount === 1 ? " — 1 cliente aguardando" : ` — ${badgeCount} clientes aguardando`}
            </span>
          </>
        ) : null}
        {item.dot ? (
          <>
            <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden="true" title="Precisa de atenção" />
            <span className="sr-only"> — precisa de atenção</span>
          </>
        ) : null}
      </Link>
    </motion.div>
  );
}

function NavGroupSection({
  group,
  openGroups,
  onToggle,
  onNavigate,
}: {
  group: NavGroup;
  openGroups: string[];
  onToggle: (id: string) => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  // Durante o tour todos os grupos ficam abertos: o Inno precisa apontar para cada item.
  const tourActive = useTour()?.active ?? false;
  const open = tourActive || openGroups.includes(group.id);
  const hasActive = group.items.some((item) => isItemActive(item, pathname));

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(group.id)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between rounded-card px-3 py-1.5 text-[10px] font-black uppercase tracking-widest",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          hasActive ? "text-sidebar-active-text" : "text-sidebar-text/60 hover:text-sidebar-text",
        )}
      >
        <span className="flex items-center gap-2">
          {group.label}
          {!open && group.items.some((item) => item.dot) ? (
            <span className="h-2 w-2 rounded-full bg-danger" aria-hidden="true" title="Precisa de atenção" />
          ) : null}
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <nav className="flex flex-col gap-1 pb-1 pt-1 text-sm" aria-label={group.label}>
              {group.items.map((item) => (
                <NavRow key={item.href} item={item} onNavigate={onNavigate} />
              ))}
            </nav>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function GroupedNav({ groups, pinned, onNavigate }: { groups: NavGroup[]; pinned?: NavItem | null; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [openGroups, setOpenGroups] = useState<string[]>(() => {
    const active = groupContainingActive(groups, pathname);
    const initial = active ? [active] : [groups[0]?.id ?? ""];
    // Grupo com item pedindo atenção (ex.: WhatsApp desconectado) nasce aberto: um alerta
    // escondido num grupo fechado é o mesmo que não existir (achado da Íris, 2026-09-29).
    const attention = groups.filter((g) => g.items.some((item) => item.dot)).map((g) => g.id);
    return [...new Set([...initial, ...attention])];
  });

  // Se a navegação mudar para um grupo ainda fechado, auto-abre (sem fechar os outros que o
  // dono já tinha aberto de propósito) — mesmo padrão do MultMarkets (premium-spec.md §2).
  // `setTimeout(fn, 0)` + cleanup: setState direto no corpo do efeito dispara o lint
  // `react-hooks/set-state-in-effect` (mesma armadilha já registrada na memória).
  useEffect(() => {
    const id = setTimeout(() => {
      const active = groupContainingActive(groups, pathname);
      if (active) {
        setOpenGroups((prev) => (prev.includes(active) ? prev : [...prev, active]));
      }
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function toggle(id: string) {
    setOpenGroups((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  }

  return (
    <div className="flex flex-col gap-3">
      {pinned ? <NavRow item={pinned} onNavigate={onNavigate} /> : null}
      {groups.map((group) => (
        <NavGroupSection key={group.id} group={group} openGroups={openGroups} onToggle={toggle} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

export function TenantSidebarNav({
  tenantSlug,
  onboardingIncomplete,
  whatsappNeedsAttention,
  onNavigate,
}: {
  tenantSlug: string;
  onboardingIncomplete?: boolean;
  whatsappNeedsAttention?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <GroupedNav
      groups={tenantNavGroups(tenantSlug, { whatsappNeedsAttention })}
      pinned={onboardingIncomplete ? tenantOnboardingItem(tenantSlug) : null}
      onNavigate={onNavigate}
    />
  );
}

export function AdminSidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return <GroupedNav groups={adminNavGroups} onNavigate={onNavigate} />;
}
