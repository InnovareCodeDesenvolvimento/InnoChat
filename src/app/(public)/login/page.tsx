import Link from "next/link";
import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { AuthShell } from "@/components/public/auth-shell";
import { AuthPanel } from "@/components/public/auth-panel";
import { GoogleEntry } from "@/components/public/google-entry";
import { authErrorMessage } from "@/components/public/google-auth-errors";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar · InnoChat" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; error?: string; redefinida?: string; instalado?: string }>;
}) {
  const { erro, error, redefinida, instalado } = await searchParams;
  const authError = authErrorMessage(error);

  return (
    <AuthShell topLink={{ prompt: "Não tem conta?", label: "Criar conta", href: "/cadastro" }}>
      <AuthPanel title="Bem-vindo de volta" description="Entre para acessar o painel da sua empresa.">
        <div className="flex flex-col gap-4">
          {authError ? (
            <Alert variant="danger" title={authError.title}>
              {authError.description}
            </Alert>
          ) : null}
          {erro === "sem-empresa" ? (
            <Alert variant="warning" title="Sem empresa vinculada">
              Sua conta ainda não está ligada a nenhuma empresa no InnoChat.
            </Alert>
          ) : null}
          {redefinida === "1" ? (
            <Alert variant="success" title="Senha redefinida">
              Já pode entrar com a nova senha.
            </Alert>
          ) : null}
          {instalado === "1" ? (
            <Alert variant="success" title="Instalação concluída">
              A conta de administrador da plataforma foi criada. Entre com o e-mail e a senha que você definiu.
            </Alert>
          ) : null}
          <GoogleEntry label="Entrar com Google" />
          <LoginForm
            forgotLink={
              <Link
                href="/recuperar-senha"
                className="inline-flex min-h-6 items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                Esqueci minha senha
              </Link>
            }
          />
        </div>
      </AuthPanel>
    </AuthShell>
  );
}
