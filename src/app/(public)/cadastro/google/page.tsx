import type { Metadata } from "next";
import { AuthShell } from "@/components/public/auth-shell";
import { getGoogleSignUpPrefillAction } from "@/modules/signup/actions";
import { GoogleSignupError, GoogleSignupForm } from "./google-signup-form";

export const metadata: Metadata = { title: "Concluir cadastro · InnoChat" };
// Cada acesso valida um token de uso único: nunca pode ser estático nem cacheado.
export const dynamic = "force-dynamic";

const SHELL = {
  formMaxWidth: "max-w-2xl" as const,
  topLink: { prompt: "Já tem conta?", label: "Entrar", href: "/login" },
};

export default async function CadastroGooglePage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;

  if (!t) {
    return (
      <AuthShell {...SHELL}>
        <GoogleSignupError reason="TOKEN_INVALID" />
      </AuthShell>
    );
  }

  const prefill = await getGoogleSignUpPrefillAction({ token: t });
  if (!prefill.ok) {
    return (
      <AuthShell {...SHELL}>
        <GoogleSignupError reason={prefill.error.code} message={prefill.error.message} />
      </AuthShell>
    );
  }

  return (
    <AuthShell {...SHELL}>
      <GoogleSignupForm token={t} email={prefill.data.email} name={prefill.data.name} />
    </AuthShell>
  );
}
