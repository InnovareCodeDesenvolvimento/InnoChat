"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowLeft, Building2, Check, IdCard, LogIn, Mail, Phone, RefreshCw, TimerOff, UserCheck, UserPlus } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { AuthInput } from "@/components/public/auth-input";
import { AUTH_SUBMIT_CLASS, AuthPanel, AuthTrust } from "@/components/public/auth-panel";
import { GoogleButton, GoogleLogo } from "@/components/public/google-button";
import { FormSection, TermsCheckbox } from "@/components/public/signup-shared";
import { SignupBillingSection } from "@/components/public/signup-billing";
import type { SignupPricing } from "@/components/public/signup-pricing";
import { normalizeDocumentDigits, validateCpfCnpj } from "@/core/billing/document";
import { effectiveCycle, type BillingCycle } from "@/core/billing/pricing";
import { maskCpfCnpj } from "@/components/lib/document-mask";
import { signInWithGoogleAction } from "@/app/(public)/google-actions";
import { completeGoogleSignUpAction } from "@/modules/signup/actions";

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

export function GoogleSignupForm({
  token,
  email,
  name,
  pricing = null,
}: {
  token: string;
  email: string;
  name: string;
  /** Preços do plano que o cadastro assume; sem eles (banco indisponível) o formulário segue sem a escolha de ciclo. */
  pricing?: SignupPricing | null;
}) {
  const router = useRouter();
  const firstName = name.trim().split(/\s+/)[0] || "";
  const [tenantName, setTenantName] = useState("");
  const [document, setDocument] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  // Cobrança depois do teste e cupom opcional: o servidor revalida os dois (mesma regra do cadastro com senha).
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("MONTHLY");
  const [couponCode, setCouponCode] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [tokenProblem, setTokenProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (tokenProblem) return <GoogleSignupError reason={tokenProblem} />;

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (tenantName.trim().length < 2) errors.tenantName = "Informe o nome da empresa.";
    if (!validateCpfCnpj(document).valid) errors.document = "Informe um CPF ou CNPJ válido.";
    if (!acceptTerms) errors.acceptedTerms = "É preciso aceitar os termos e a privacidade.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;

    startTransition(async () => {
      const result = await completeGoogleSignUpAction({
        token,
        tenantName: tenantName.trim(),
        document: normalizeDocumentDigits(document),
        billingCycle: pricing ? effectiveCycle(pricing, billingCycle) : "MONTHLY",
        couponCode: couponCode.trim() || undefined,
        acceptTerms,
      });

      if (!result.ok) {
        const code = result.error.code;
        if (code === "TOKEN_INVALID" || code === "TOKEN_EXPIRED" || code === "ALREADY_REGISTERED") {
          setTokenProblem(code);
          return;
        }
        if (code === "INVALID_DOCUMENT") {
          setFieldErrors((prev) => ({ ...prev, document: "Informe um CPF ou CNPJ válido." }));
          return;
        }
        if (code.startsWith("COUPON_") || code === "INVALID_CYCLE") {
          setCouponError(result.error.message);
          return;
        }
        setFormError(result.error.message);
        return;
      }
      router.push(result.data.redirectTo);
    });
  }

  return (
    <AuthPanel
      title={firstName ? `Falta pouco, ${firstName}!` : "Falta pouco!"}
      description="Conte sobre a sua empresa para criar a conta. Você entra com o Google, sem precisar de senha."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
        {formError ? <Alert variant="danger">{formError}</Alert> : null}

        <FormSection step={1} title="Sua empresa" id="sec-empresa">
          <div className="md:col-span-2 lg:col-span-1 xl:col-span-2">
            <Field label="E-mail da conta Google" htmlFor="google-email" hint="Vem do Google e não pode ser alterado aqui.">
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
          </div>
          <div className="md:col-span-2 lg:col-span-1 xl:col-span-2">
            <Field label="Nome da empresa" htmlFor="tenantName" required error={fieldErrors.tenantName}>
              {(fieldProps) => (
                <AuthInput
                  {...fieldProps}
                  icon={Building2}
                  name="tenantName"
                  autoComplete="organization"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  maxLength={120}
                  invalid={!!fieldErrors.tenantName}
                />
              )}
            </Field>
          </div>
          <Field
            label="CPF ou CNPJ"
            htmlFor="document"
            required
            error={fieldErrors.document}
            hint={!fieldErrors.document ? "Usado para gerar a cobrança Pix da assinatura." : undefined}
          >
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={IdCard}
                name="document"
                inputMode="numeric"
                autoComplete="off"
                value={maskCpfCnpj(document)}
                onChange={(e) => setDocument(normalizeDocumentDigits(e.target.value))}
                maxLength={18}
                invalid={!!fieldErrors.document}
              />
            )}
          </Field>
        </FormSection>

        <FormSection step={2} title="Depois do teste" id="sec-cobranca">
          <SignupBillingSection
            pricing={pricing}
            cycle={billingCycle}
            onCycleChange={setBillingCycle}
            couponCode={couponCode}
            onCouponCodeChange={(code) => {
              setCouponCode(code);
              setCouponError(null);
            }}
            couponError={couponError}
          />
        </FormSection>

        <section aria-labelledby="sec-termos" className="flex flex-col gap-4">
          <h2 id="sec-termos" className="flex items-center gap-2.5 font-display text-sm font-bold text-text">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold tabular-nums text-primary ring-1 ring-primary/25"
            >
              3
            </span>
            Termos
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          </h2>
          <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} error={fieldErrors.acceptedTerms} />
        </section>

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
