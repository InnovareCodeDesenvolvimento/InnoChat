import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import "@/app/globals.css";
import { fontVariables } from "@/app/fonts";
import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/db/prisma";
import { ToastProvider } from "@/components/ui/toast";
import { ClientErrorReporter } from "@/components/error-monitor/client-error-reporter";
import { HelpVisibilityProvider } from "@/components/help/help-visibility";
import { NavigationProgress } from "@/components/shell/navigation-progress";
import { AdminShell } from "@/components/shell/admin-shell";
import { TwoFactorCard } from "@/components/account/two-factor-card";
import { getTwoFactorStatus } from "@/modules/two-factor/service";

export const metadata: Metadata = { title: "InnoChat · Admin da plataforma" };

/**
 * Root layout do admin da plataforma. Tema fixo Índigo Clínico — não é
 * marca de nenhuma empresa cliente, é a operação do dono do InnoChat.
 * Só `isPlatformAdmin` entra; qualquer outro usuário autenticado recebe 404
 * (não confirma a existência da rota para quem não é admin).
 *
 * VERIFICAÇÃO EM 2 ETAPAS OBRIGATÓRIA: admin sem 2FA ligada não vê página nenhuma do /admin; o
 * layout troca o conteúdo pela tela de ativação (sem depender do caminho, então não há laço de
 * redirecionamento). As server actions (`requirePlatformAdmin`) continuam checando só o papel.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const user = await getPrisma().user.findUnique({
    where: { id: session.user.id },
    select: { isPlatformAdmin: true, email: true, name: true, totpEnabledAt: true },
  });

  if (!user?.isPlatformAdmin) {
    notFound();
  }

  // Admin sem 2FA ligada: só a tela de ativação.
  const twoFactorGate = user.totpEnabledAt ? null : await getTwoFactorStatus(session.user.id);

  return (
    <html lang="pt-BR" data-theme="INDIGO_CLINICO" className={fontVariables}>
      <body>
        <NavigationProgress />
        <ClientErrorReporter />
        <ToastProvider>
          <HelpVisibilityProvider>
            <AdminShell userEmail={user.email} userName={user.name}>{twoFactorGate ? <TwoFactorCard status={twoFactorGate} forced /> : children}</AdminShell>
          </HelpVisibilityProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
