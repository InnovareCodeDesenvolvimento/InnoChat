"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Building2, Lock, Mail, MailCheck, Phone, RefreshCw, Ticket, User, UserPlus } from "lucide-react";
import { Field } from "@/components/ui/field";
import { AuthInput } from "@/components/public/auth-input";
import { AUTH_SUBMIT_CLASS, AuthPanel, AuthTrust } from "@/components/public/auth-panel";
import { TermsCheckbox } from "@/components/public/signup-shared";
import { GoogleExternalButton } from "@/components/public/google-external-button";
import { OrDivider } from "@/components/public/google-button";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { suggestEmail } from "@/core/signup/email-suggest";
import { normalizeBrPhoneToE164 } from "@/core/contact/br-phone";
import { maskBrPhone } from "@/components/lib/phone-mask";
import { isPixelActive, newEventId, trackPixel } from "@/components/public/meta-events";
import { signUpAction } from "@/modules/signup/actions";
import { TERMS_VERSION } from "@/lib/legal";

export type SignupCoupon = { code: string; summary: string };

type FormState = {
  companyName: string;
  name: string;
  phone: string;
  email: string;
  password: string;
  acceptedTerms: boolean;
  /** Isca para robô: pessoa de verdade nunca vê nem preenche. */
  website: string;
};

const EMPTY_FORM: FormState = {
  companyName: "",
  name: "",
  phone: "",
  email: "",
  password: "",
  acceptedTerms: false,
  website: "",
};

const PHONE_ERROR = "Confira o WhatsApp: DDD e número, como (84) 99999-8888.";
const GENERIC_ERROR = "Não deu para criar a conta agora. Confira os dados e tente de novo.";

export function CadastroForm({
  top,
  coupon = null,
  googleExternalHref = null,
}: {
  top?: React.ReactNode;
  /** Cupom que veio no link (`?cupom=`), já conferido no servidor. Nunca é digitado aqui. */
  coupon?: SignupCoupon | null;
  /**
   * Navegador embutido do Instagram/Facebook (o Google recusa o login ali): endereço que abre esta mesma
   * página no navegador do sistema e inicia o Google lá. O formulário com e-mail e senha segue como caminho principal.
   */
  googleExternalHref?: string | null;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [termsOutdated, setTermsOutdated] = useState(false);
  const [emailTaken, setEmailTaken] = useState(false);
  const [emailSuggestion, setEmailSuggestion] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string } | null>(null);
  // Conta criada e sessão aberta: o botão fica "criando" até a página trocar, para ninguém tocar duas vezes.
  const [redirecting, setRedirecting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const leadSentRef = useRef(false);

  // Lead: a primeira vez que a pessoa mexe no cadastro (campo ou botão do Google). Uma vez só por visita.
  function handleStart() {
    if (leadSentRef.current) return;
    leadSentRef.current = true;
    trackPixel("Lead");
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validateClientSide(): boolean {
    const errors: Record<string, string> = {};
    if (form.companyName.trim().length < 2) errors.companyName = "Informe o nome da empresa.";
    if (form.name.trim().length < 2) errors.name = "Informe seu nome (pelo menos 2 letras).";
    else if (form.name.trim().length > 80) errors.name = "O nome pode ter no máximo 80 caracteres.";
    if (!form.phone.trim()) errors.phone = "Informe seu WhatsApp. É por ele que avisamos sobre o teste.";
    else if (!normalizeBrPhoneToE164(form.phone)) errors.phone = PHONE_ERROR;
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) errors.email = "Informe um e-mail válido.";
    if (form.password.length < 8) errors.password = "A senha precisa ter pelo menos 8 caracteres.";
    if (!form.acceptedTerms) errors.acceptedTerms = "É preciso aceitar os termos e a privacidade.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setTermsOutdated(false);
    setEmailTaken(false);
    if (!validateClientSide()) return;

    // Só existe id de evento se o visitante aceitou o Pixel: sem ele o servidor não manda nada à Meta.
    const metaEventId = isPixelActive() ? newEventId() : undefined;
    const email = form.email.trim();

    startTransition(async () => {
      const result = await signUpAction({
        companyName: form.companyName.trim(),
        name: form.name.trim(),
        phone: form.phone.trim(),
        email,
        password: form.password,
        termsVersion: TERMS_VERSION,
        acceptedTerms: form.acceptedTerms,
        couponCode: coupon?.code,
        metaEventId,
        hp_confirm_field: form.website,
      });

      if (!result.ok) {
        const code = result.error.code;
        if (code === "EMAIL_TAKEN") {
          setFieldErrors((prev) => ({ ...prev, email: "Já existe uma conta com este e-mail." }));
          setEmailTaken(true);
          return;
        }
        if (code === "DISPOSABLE_EMAIL") {
          setFieldErrors((prev) => ({
            ...prev,
            email: "Use um e-mail que você acessa sempre: é por ele que chegam os avisos da conta.",
          }));
          return;
        }
        if (code === "INVALID_PHONE") {
          setFieldErrors((prev) => ({ ...prev, phone: PHONE_ERROR }));
          return;
        }
        if (code === "TERMS_VERSION_OUTDATED") {
          setTermsOutdated(true);
          return;
        }
        if (code === "RATE_LIMITED") {
          setFormError(result.error.message);
          return;
        }
        // Qualquer outro código (validação técnica, endereço, legado) vira uma frase que a pessoa entende.
        setFormError(GENERIC_ERROR);
        return;
      }

      if (result.data.sessionStarted) {
        // Conta criada e já logada: conta a conversão e segue direto para o painel (sem passar por "confirme seu e-mail").
        if (metaEventId) trackPixel("CompleteRegistration", metaEventId);
        setRedirecting(true);
        // Navegação completa de propósito: o cookie de sessão acabou de nascer e a página seguinte precisa lê-lo do zero (router.push poderia reaproveitar um retorno em cache feito sem sessão).
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/pos-login");
        return;
      }

      if (metaEventId) trackPixel("CompleteRegistration", metaEventId);
      setDone({ email });
    });
  }

  if (done) {
    return (
      <AuthPanel>
        <EmptyState
          icon={MailCheck}
          title="Confirme seu e-mail"
          description={`Enviamos um link de confirmação para ${done.email}. Abra sua caixa de entrada (e o spam também) para ativar a conta.`}
          action={
            <Button asChild variant="secondary">
              <Link href="/login">Ir para o login</Link>
            </Button>
          }
        />
      </AuthPanel>
    );
  }

  return (
    <AuthPanel title="Crie sua conta grátis" description="3 dias de teste. Sem cartão." className="p-5 sm:p-8" compact>
      <div onFocusCapture={handleStart} onClickCapture={handleStart}>
        {top ? <div className="mb-4 flex flex-col gap-4">{top}</div> : null}
        {coupon ? (
          <p
            data-testid="cadastro-cupom"
            className="mb-4 flex items-start gap-2 rounded-card bg-primary/10 px-3 py-2 text-sm text-text ring-1 ring-primary/25"
          >
            <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>
              Cupom <strong className="font-semibold">{coupon.code}</strong> aplicado: {coupon.summary}.
            </span>
          </p>
        ) : null}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {termsOutdated ? (
            <Alert variant="warning" title="Os termos foram atualizados">
              <div className="flex flex-col gap-2">
                <span>A página que você abriu ficou com uma versão antiga dos termos. Recarregue e confirme de novo.</span>
                <Button type="button" variant="secondary" size="sm" icon={RefreshCw} className="w-fit" onClick={() => window.location.reload()}>
                  Recarregar página
                </Button>
              </div>
            </Alert>
          ) : null}
          {formError ? <Alert variant="danger">{formError}</Alert> : null}

          <Field label="Nome da empresa" htmlFor="companyName" required error={fieldErrors.companyName}>
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={Building2}
                name="companyName"
                autoComplete="organization"
                enterKeyHint="next"
                value={form.companyName}
                onChange={(e) => set("companyName", e.target.value)}
                maxLength={120}
                invalid={!!fieldErrors.companyName}
              />
            )}
          </Field>

          <Field label="Seu nome" htmlFor="name" required error={fieldErrors.name}>
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={User}
                name="name"
                autoComplete="name"
                enterKeyHint="next"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                maxLength={80}
                invalid={!!fieldErrors.name}
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
                enterKeyHint="next"
                placeholder="(84) 99999-8888"
                value={form.phone}
                onChange={(e) => set("phone", maskBrPhone(e.target.value))}
                maxLength={16}
                invalid={!!fieldErrors.phone}
              />
            )}
          </Field>

          <div>
            <Field label="E-mail" htmlFor="email" required error={fieldErrors.email}>
              {(fieldProps) => (
                <AuthInput
                  {...fieldProps}
                  icon={Mail}
                  type="email"
                  name="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  value={form.email}
                  onChange={(e) => {
                    set("email", e.target.value);
                    setEmailSuggestion(null);
                    setEmailTaken(false);
                  }}
                  onBlur={() => setEmailSuggestion(suggestEmail(form.email))}
                  invalid={!!fieldErrors.email}
                />
              )}
            </Field>
            {emailSuggestion ? (
              <p className="mt-1.5 text-sm text-text-secondary" data-testid="cadastro-sugestao-email">
                Você quis dizer{" "}
                <button
                  type="button"
                  onClick={() => {
                    set("email", emailSuggestion);
                    setEmailSuggestion(null);
                    setFieldErrors((prev) => ({ ...prev, email: "" }));
                  }}
                  className="-my-3 inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {emailSuggestion}
                </button>
                ?
              </p>
            ) : null}
            {emailTaken ? (
              <p className="mt-1 text-sm text-text-secondary" data-testid="cadastro-email-existente">
                <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4">
                  Entrar
                </Link>
                <span aria-hidden="true"> · </span>
                <Link href="/recuperar-senha" className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4">
                  Esqueci a senha
                </Link>
              </p>
            ) : null}
          </div>

          <Field label="Senha" htmlFor="password" required error={fieldErrors.password} hint="Pelo menos 8 caracteres.">
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={Lock}
                type="password"
                name="password"
                autoComplete="new-password"
                enterKeyHint="done"
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                invalid={!!fieldErrors.password}
              />
            )}
          </Field>

          {/* Isca para robô. `inert` tira do teclado e do leitor de tela sem precisar de tabindex; fora da tela, sem display:none (robô simples ignora campo display:none). */}
          <div aria-hidden="true" inert className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
            <input
              type="text"
              name="hp_confirm_field"
              autoComplete="off"
              value={form.website}
              onChange={(e) => set("website", e.target.value)}
            />
          </div>

          <TermsCheckbox
            checked={form.acceptedTerms}
            onChange={(checked) => set("acceptedTerms", checked)}
            error={fieldErrors.acceptedTerms}
          />

          <div>
            <Button
              icon={UserPlus}
              type="submit"
              size="lg"
              isLoading={isPending || redirecting}
              className={AUTH_SUBMIT_CLASS}
              loadingText={redirecting ? "Abrindo seu painel…" : "Criando conta…"}
            >
              Criar conta grátis
            </Button>
            <AuthTrust />
          </div>
        </form>
        {googleExternalHref ? (
          <div className="mt-5 flex flex-col gap-4">
            <OrDivider />
            <GoogleExternalButton href={googleExternalHref} />
          </div>
        ) : null}
      </div>
    </AuthPanel>
  );
}
