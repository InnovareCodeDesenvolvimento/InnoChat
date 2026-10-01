import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import { AuthPanel } from "@/components/public/auth-panel";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/public/auth-shell";
import { verifyEmailAction } from "@/modules/signup/actions";

export const metadata: Metadata = { title: "Confirmar e-mail · InnoChat" };

export default async function VerificarEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <AuthShell>
        <AuthPanel title="Link incompleto" description="Este link de confirmação está sem o código necessário.">
            <Button asChild>
              <Link href="/login">Ir para o login</Link>
            </Button>
          </AuthPanel>
      </AuthShell>
    );
  }

  const result = await verifyEmailAction({ token });

  return (
    <AuthShell>
      <AuthPanel
        title={result.ok ? "E-mail confirmado!" : "Não foi possível confirmar"}
        description={
          result.ok
            ? "Sua conta está pronta. Já pode entrar."
            : "Este link é inválido, já foi usado ou expirou. Peça um novo pelo login."
        }
      >
        <div
          className={`mb-6 flex h-12 w-12 items-center justify-center rounded-full ${
            result.ok ? "bg-success-bg" : "bg-danger-bg"
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="h-6 w-6 text-success" aria-hidden="true" />
          ) : (
            <XCircle className="h-6 w-6 text-danger" aria-hidden="true" />
          )}
        </div>
        <Button asChild size="lg" className="w-full">
          <Link href={result.ok && result.data.tenantSlug ? `/${result.data.tenantSlug}/inicio` : "/login"}>
            {result.ok ? "Ir para o painel" : "Ir para o login"}
          </Link>
        </Button>
      </AuthPanel>
    </AuthShell>
  );
}
