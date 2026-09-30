import { AdminSidebarNav } from "./sidebar-nav";
import { InnovareCodeBadge } from "@/components/brand/innovarecode-badge";
import { MobileNav } from "./mobile-nav";
import { UserBlock } from "./user-block";
import { AdminSectionLabel } from "./section-label";
import { BackgroundGlow } from "./background-glow";
import { CommandPalette } from "./command-palette";
import { PageTransition } from "./page-transition";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { PlatformNotificationCenterProvider } from "@/components/notifications/notification-center-provider";

type AdminShellProps = {
  userEmail: string;
  userName?: string | null;
  children: React.ReactNode;
};

function AdminBrand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-card bg-gradient-to-br from-primary to-primary-strong font-display text-sm font-bold text-white shadow-card">
        IC
      </div>
      <span className="truncate font-display text-sm font-bold text-sidebar-text">
        InnoChat · Plataforma
      </span>
    </div>
  );
}

/** Shell do admin da plataforma — mesmo padrão premium do painel do tenant, tema fixo Índigo Clínico. */
export function AdminShell({ userEmail, userName = null, children }: AdminShellProps) {
  return (
    <PlatformNotificationCenterProvider>
    <div className="relative flex min-h-screen">
      <BackgroundGlow />
      <aside className="relative z-10 hidden w-64 shrink-0 flex-col panel-sidebar-surface px-4 py-6 lg:sticky! lg:top-0 lg:flex lg:h-screen lg:self-start">
        <div className="mb-8 px-2">
          <AdminBrand />
        </div>
        <div className="flex-1 overflow-y-auto">
          <AdminSidebarNav />
        </div>
        <div className="mt-4 border-t border-white/10 pt-4">
          <UserBlock userEmail={userEmail} userName={userName} accountHref="/admin/minha-conta" />
          <InnovareCodeBadge className="mt-3" />
        </div>
      </aside>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border bg-surface/70 px-4 backdrop-blur-2xl sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <MobileNav
              variant="admin"
              brand={<AdminBrand />}
              footer={
                <>
                  <UserBlock userEmail={userEmail} userName={userName} accountHref="/admin/minha-conta" />
                  <InnovareCodeBadge className="mt-3" />
                </>
              }
            />
            <span className="truncate font-display text-sm font-bold text-text lg:hidden">Plataforma</span>
            <AdminSectionLabel />
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <CommandPalette variant="admin" />
            <NotificationBell
              timezone="America/Sao_Paulo"
              emptyHint="Novos cadastros, pagamentos e alertas da plataforma aparecem aqui."
            />
          </div>
        </header>

        <main className="flex-1 p-4 pb-20 sm:p-6 sm:pb-20">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
    </PlatformNotificationCenterProvider>
  );
}
