import type { Metadata } from "next";
import { AuthShell } from "@/components/public/auth-shell";
import { Alert } from "@/components/ui/alert";
import { GoogleEntry } from "@/components/public/google-entry";
import { authErrorMessage } from "@/components/public/google-auth-errors";
import { MetaTracking } from "@/components/public/meta-tracking";
import { getDefaultSignupPlan } from "@/modules/billing/service";
import { signupPricingOf } from "@/components/public/signup-pricing";
import { CadastroForm } from "./cadastro-form";

export const metadata: Metadata = { title: "Criar conta · InnoChat" };

export default async function CadastroPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const authError = authErrorMessage((await searchParams).error);
  // Preços do plano que o cadastro assume, para a escolha do ciclo (1, 3, 6 ou 12 meses). Sem banco ou sem plano: o formulário segue sem a escolha.
  const plan = await getDefaultSignupPlan().catch(() => null);
  const pricing = signupPricingOf(plan);
  return (
    <AuthShell formMaxWidth="max-w-2xl" topLink={{ prompt: "Já tem conta?", label: "Entrar", href: "/login" }}>
      <CadastroForm
        pricing={pricing}
        top={
          <>
            {authError ? (
              <Alert variant="danger" title={authError.title}>
                {authError.description}
              </Alert>
            ) : null}
            <GoogleEntry label="Cadastrar com Google" />
          </>
        }
      />
      <MetaTracking stripQuery />
    </AuthShell>
  );
}
