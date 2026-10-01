import type { Metadata } from "next";
import "@/app/globals.css";
import { fontVariables } from "@/app/fonts";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "InnoChat",
  description: "InnoChat: agenda e atendimento pelo WhatsApp",
};

/**
 * Root layout das telas públicas (entrada, login, cadastro). Tema fixo
 * Índigo Clínico (decisão do dono, docs/design/direcoes.md) — telas públicas
 * não seguem o tema da empresa porque, nesse ponto, ainda não há empresa
 * resolvida.
 *
 * É um ROOT layout próprio (multi-root layout do App Router): não existe
 * `src/app/layout.tsx` compartilhado — cada grupo de topo `(public)`,
 * `(app)/[tenantSlug]` e `(platform)/admin` define seu próprio `<html>`,
 * porque cada um resolve o tema de um jeito diferente (fixo, por tenant,
 * fixo).
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" data-theme="INDIGO_CLINICO" className={fontVariables}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
