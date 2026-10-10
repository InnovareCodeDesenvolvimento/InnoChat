"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowLeft, Building2, LogIn, Mail, Phone, RefreshCw, TimerOff, UserCheck, UserPlus } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { AuthInput } from "@/components/public/auth-input";
import { AUTH_SUBMIT_CLASS, AuthPanel, AuthTrust } from "@/components/public/auth-panel";
import { GoogleButton, GoogleLogo } from "@/components/public/google-button";
import { TermsCheckbox } from "@/components/public/signup-shared";
import { normalizeBrPhoneToE164 } from "@/core/contact/br-phone";
import { maskBrPhone } from "@/components/lib/phone-mask";
import { signInWithGoogleAction } from "@/app/(public)/google-actions";
import { completeGoogleSignUpAction } from "@/modules/signup/actions";

const PHONE_ERROR = "Confira o WhatsApp: DDD e número, como (84) 99999-8888.";
const GENERIC_ERROR = "Não deu para criar a conta agora. Confira os dados e tente de novo.";

/** Estado de erro do link: token ausente, inválido, expirado (ou falha ao ler). */
export function GoogleSignupError({ reason, message }: { reason: string; message?: string }) {
  if (reason === "ALREADY_REGISTERED") {
    return (
      <AuthPanel>
        <div role="alert" className="flex flex-col items-center gap-4 py-4 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-hero bg-primary/10 text-primary ring-1 ring-primary/25">
            <UserCheck className="h-7 w-7" aria-hidden="true" />
          </span>
          <div>
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-text">Você já tem conta</h1>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary sm:text-base">
              Você já tem conta. Entre com o Google.
            </p>
          </div>
          <div className="w-full max-w-sm">
            <GoogleButton label="Entrar com Google" action={signInWithGoogleAction} />
          </div>
        </div>
      </AuthPanel>
    );
  }
  const expired = reason === "TOKEN_EXPIRED";
  const Icon = expired ? TimerOff : RefreshCw;
  const title = expired ? "O tempo para concluir acabou" : "Esse link não é válido";
  const description = expired
    ? "Por segurança, o link para concluir o cadastro com o Google vale por poucos minutos. Volte e comece de novo."
    : reason === "TOKEN_INVALID"
      ? "O link está incompleto, já foi usado ou é de outro cadastro. Volte e comece de novo."
      : (message ?? "Não foi possível abrir esta etapa agora. Volte e tente de novo.");
  return (
    <AuthPanel>
      <div role="alert" className="flex flex-col items-center gap-4 py-4 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-hero bg-warning-bg text-warning ring-1 ring-warning/25">
          <Icon className="h-7 w-7" aria-hidden="true" />
        </span>
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-text">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary sm:text-base">{description}</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <Button asChild size="lg">
            <Link href="/cadastro">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Voltar e tentar de novo
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link href="/login">
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Ir para o login
            </Link>
          </Button>
        </div>
      </div>
    </AuthPanel>
  );
}

export function GoogleSignupForm({ token, email, name }: { token: string; email: string; name: string }) {
  const router = useRouter();
  const firstName = name.trim().split(/\s+/)[0] || "";
  const [tenantName, setTenantName] = useState("");
  const [phone, setPhone] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [tokenProblem, setTokenProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (tokenProblem) return <GoogleSignupError reason={tokenProblem} />;

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (tenantName.trim().length < 2) errors.tenantName = "Informe o nome da empresa.";
    if (!phone.trim()) errors.phone = "Informe seu WhatsApp. É por ele que avisamos sobre o teste.";
    else if (!normalizeBrPhoneToE164(phone)) errors.phone = PHONE_ERROR;
    if (!acceptTerms) errors.acceptedTerms = "É preciso aceitar os termos e a privacidade.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;

    startTransition(async () => {
      // O cupom do link não passa por aqui: o servidor lê do cookie que guardou antes de ir ao Google.
      const result = await completeGoogleSignUpAction({
        token,
        tenantName: tenantName.trim(),
        phone: phone.trim(),
        acceptTerms,
      });

      if (!result.ok) {
        const code = result.error.code;
        if (code === "TOKEN_INVALID" || code === "TOKEN_EXPIRED" || code === "ALREADY_REGISTERED") {
          setTokenProblem(code);
          return;
        }
        if (code === "INVALID_PHONE") {
          setFieldErrors((prev) => ({ ...prev, phone: PHONE_ERROR }));
          return;
        }
        setFormError(code === "RATE_LIMITED" ? result.error.message : GENERIC_ERROR);
        return;
      }
      router.push(result.data.redirectTo);
    });
  }

  return (
    <AuthPanel
      title={firstName ? `Falta pouco, ${firstName}!` : "Falta pouco!"}
      description="Só mais dois dados e sua conta está pronta. Você entra com o Google, sem senha."
      compact
      className="p-5 sm:p-8"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        {formError ? <Alert variant="danger">{formError}</Alert> : null}

        <Field label="E-mail da conta Google" htmlFor="google-email">
          {(fieldProps) => (
            <div className="relative">
              <AuthInput
                {...fieldProps}
                icon={Mail}
                type="email"
                name="googleEmail"
                value={email}
                readOnly
                className="bg-bg pr-12 text-text-secondary"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-white"
              >
                <GoogleLogo className="h-4 w-4" />
              </span>
            </div>
          )}
        </Field>

        <Field label="Nome da empresa" htmlFor="tenantName" required error={fieldErrors.tenantName}>
          {(fieldProps) => (
            <AuthInput
              {...fieldProps}
              icon={Building2}
              name="tenantName"
              autoComplete="organization"
              enterKeyHint="next"
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              maxLength={120}
              invalid={!!fieldErrors.tenantName}
            />
          )}
        </Field>

        <Field
          label="Seu WhatsApp"
          htmlFor="phone"
          required
          error={fieldErrors.phone}
          hint="É por onde avisamos sobre o teste e a mensalidade."
        >
          {(fieldProps) => (
            <AuthInput
              {...fieldProps}
              icon={Phone}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="done"
              placeholder="(84) 99999-8888"
              value={phone}
              onChange={(e) => setPhone(maskBrPhone(e.target.value))}
              maxLength={16}
              invalid={!!fieldErrors.phone}
            />
          )}
        </Field>

        <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} error={fieldErrors.acceptedTerms} />

        <div>
          <Button
            icon={UserPlus}
            type="submit"
            size="lg"
            isLoading={isPending}
            className={AUTH_SUBMIT_CLASS}
            loadingText="Criando conta…"
          >
            Concluir cadastro
          </Button>
          <AuthTrust trial />
        </div>
      </form>
    </AuthPanel>
  );
}
