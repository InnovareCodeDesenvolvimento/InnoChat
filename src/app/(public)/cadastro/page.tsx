import type { Metadata } from "next";
import { AuthShell } from "@/components/public/auth-shell";
import { Alert } from "@/components/ui/alert";
import { GoogleEntry } from "@/components/public/google-entry";
import { authErrorMessage } from "@/components/public/google-auth-errors";
import { CadastroForm } from "./cadastro-form";

export const metadata: Metadata = { title: "Criar conta · InnoChat" };

export default async function CadastroPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const authError = authErrorMessage((await searchParams).error);
  return (
    <AuthShell formMaxWidth="max-w-2xl" topLink={{ prompt: "Já tem conta?", label: "Entrar", href: "/login" }}>
      <CadastroForm
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
    </AuthShell>
  );
}
