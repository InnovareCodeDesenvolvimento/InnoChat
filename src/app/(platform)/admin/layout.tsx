import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import "@/app/globals.css";
import { fontVariables } from "@/app/fonts";
import { auth } from "@/lib/auth";
import { getPrisma } from "@/lib/db/prisma";
import { ToastProvider } from "@/components/ui/toast";
import { NavigationProgress } from "@/components/shell/navigation-progress";
import { AdminShell } from "@/components/shell/admin-shell";

export const metadata: Metadata = { title: "InnoChat · Admin da plataforma" };

/**
 * Root layout do admin da plataforma. Tema fixo Índigo Clínico — não é
 * marca de nenhuma empresa cliente, é a operação do dono do InnoChat.
 * Só `isPlatformAdmin` entra; qualquer outro usuário autenticado recebe 404
 * (não confirma a existência da rota para quem não é admin).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const user = await getPrisma().user.findUnique({
    where: { id: session.user.id },
    select: { isPlatformAdmin: true, email: true, name: true },
  });

  if (!user?.isPlatformAdmin) {
    notFound();
  }

  return (
    <html lang="pt-BR" data-theme="INDIGO_CLINICO" className={fontVariables}>
      <body>
        <NavigationProgress />
        <ToastProvider>
          <AdminShell userEmail={user.email} userName={user.name}>{children}</AdminShell>
        </ToastProvider>
      </body>
    </html>
  );
}
