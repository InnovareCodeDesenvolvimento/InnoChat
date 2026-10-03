"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { Building2, IdCard, Link2, Lock, Mail, MailCheck, Phone, RefreshCw, Tag, User, UserPlus } from "lucide-react";
import { Field } from "@/components/ui/field";
import { AuthInput } from "@/components/public/auth-input";
import { AUTH_SUBMIT_CLASS, AuthPanel, AuthTrust } from "@/components/public/auth-panel";
import { FormSection, TermsCheckbox } from "@/components/public/signup-shared";
import { SignupBillingSection, type SignupPricing } from "@/components/public/signup-billing";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { slugify, validateSlug, type SlugValidationError } from "@/core/signup/slug";
import { effectiveCycle, type BillingCycle } from "@/core/billing/pricing";
import { normalizeDocumentDigits, validateCpfCnpj } from "@/core/billing/document";
import { maskCpfCnpj } from "@/components/lib/document-mask";
import { normalizeBrPhoneToE164 } from "@/core/contact/br-phone";
import { isPixelActive, newEventId, trackPixel } from "@/components/public/meta-events";
import { signUpAction } from "@/modules/signup/actions";
import { TERMS_VERSION } from "@/lib/legal";

const SLUG_ERROR_MESSAGE: Record<SlugValidationError, string> = {
  TOO_SHORT: "O endereço precisa ter pelo menos 3 letras.",
  TOO_LONG: "O endereço pode ter no máximo 60 caracteres.",
  INVALID_FORMAT: "Use só letras minúsculas, números e hífen, sem espaços, acentos ou símbolos.",
  RESERVED: "Esse endereço já é reservado pelo sistema. Escolha outro.",
};

type FormState = {
  companyName: string;
  slug: string;
  slugTouched: boolean;
  segment: string;
  ownerName: string;
  document: string;
  phone: string;
  email: string;
  password: string;
  confirmPassword: string;
  acceptedTerms: boolean;
};

const EMPTY_FORM: FormState = {
  companyName: "",
  slug: "",
  slugTouched: false,
  segment: "",
  ownerName: "",
  document: "",
  phone: "",
  email: "",
  password: "",
  confirmPassword: "",
  acceptedTerms: false,
};

export function CadastroForm({ top, pricing = null }: { top?: React.ReactNode; pricing?: SignupPricing | null }) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // Cobrança depois do teste (1, 3, 6 ou 12 meses) e cupom opcional: o servidor revalida os dois.
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("MONTHLY");
  const [couponCode, setCouponCode] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [termsOutdated, setTermsOutdated] = useState(false);
  const [done, setDone] = useState<{ email: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const leadSentRef = useRef(false);

  // Lead: a primeira vez que a pessoa mexe no cadastro (campo ou botão do Google). Uma vez só por visita.
  function handleStart() {
    if (leadSentRef.current) return;
    leadSentRef.current = true;
    trackPixel("Lead");
  }

  const slugValidation = useMemo(() => (form.slug ? validateSlug(form.slug) : null), [form.slug]);

  function handleCompanyNameChange(value: string) {
    setForm((f) => ({
      ...f,
      companyName: value,
      slug: f.slugTouched ? f.slug : slugify(value),
    }));
  }

  function handleSlugChange(value: string) {
    setForm((f) => ({ ...f, slug: slugify(value), slugTouched: true }));
  }

  function validateClientSide(): boolean {
    const errors: Record<string, string> = {};
    if (form.companyName.trim().length < 2) errors.companyName = "Informe o nome da empresa.";
    if (slugValidation) errors.slug = SLUG_ERROR_MESSAGE[slugValidation];
    if (!form.slug) errors.slug = "Escolha um endereço para a empresa.";
    if (form.ownerName.trim().length < 2) errors.ownerName = "Informe seu nome (pelo menos 2 letras).";
    else if (form.ownerName.trim().length > 80) errors.ownerName = "O nome pode ter no máximo 80 caracteres.";
    if (!validateCpfCnpj(form.document).valid) errors.document = "Informe um CPF ou CNPJ válido.";
    if (form.phone.trim() && !normalizeBrPhoneToE164(form.phone)) errors.phone = "Confira o WhatsApp: DDD e número, como (84) 99999-8888.";
    if (!form.email.includes("@")) errors.email = "Informe um e-mail válido.";
    if (form.password.length < 8) errors.password = "A senha precisa ter pelo menos 8 caracteres.";
    if (form.password !== form.confirmPassword) errors.confirmPassword = "As senhas não são iguais.";
    if (!form.acceptedTerms) errors.acceptedTerms = "É preciso aceitar os termos e a privacidade.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCouponError(null);
    setTermsOutdated(false);
    if (!validateClientSide()) return;

    // Só existe id de evento se o visitante aceitou o Pixel: sem ele o servidor não manda nada à Meta.
    const metaEventId = isPixelActive() ? newEventId() : undefined;

    startTransition(async () => {
      const result = await signUpAction({
        companyName: form.companyName.trim(),
        slug: form.slug,
        segment: form.segment.trim() || undefined,
        ownerName: form.ownerName.trim(),
        // `document` ainda não está no contrato de `signUpAction` (a Vega está adicionando) —
        // manda de qualquer forma: quando o servidor aceitar, funciona sem mudança nenhuma aqui.
        document: normalizeDocumentDigits(form.document),
        phone: form.phone.trim() || undefined,
        email: form.email.trim(),
        password: form.password,
        termsVersion: TERMS_VERSION,
        acceptedTerms: form.acceptedTerms,
        billingCycle: pricing ? effectiveCycle(pricing, billingCycle) : "MONTHLY",
        couponCode: couponCode.trim() || undefined,
        metaEventId,
      });

      if (!result.ok) {
        if (result.error.code === "SLUG_TAKEN") {
          setFieldErrors((prev) => ({ ...prev, slug: "Esse endereço já está em uso. Escolha outro." }));
          return;
        }
        if (result.error.code === "EMAIL_TAKEN") {
          setFieldErrors((prev) => ({ ...prev, email: "Já existe uma conta com este e-mail." }));
          return;
        }
        if (result.error.code === "INVALID_SLUG") {
          setFieldErrors((prev) => ({ ...prev, slug: "Endereço inválido. Ajuste e tente de novo." }));
          return;
        }
        if (result.error.code === "INVALID_DOCUMENT") {
          setFieldErrors((prev) => ({ ...prev, document: "Informe um CPF ou CNPJ válido." }));
          return;
        }
        if (result.error.code === "INVALID_PHONE") {
          setFieldErrors((prev) => ({ ...prev, phone: "Confira o WhatsApp: DDD e número, como (84) 99999-8888." }));
          return;
        }
        if (result.error.code.startsWith("COUPON_") || result.error.code === "INVALID_CYCLE") {
          setCouponError(result.error.message);
          return;
        }
        if (result.error.code === "TERMS_VERSION_OUTDATED") {
          setTermsOutdated(true);
          return;
        }
        setFormError(result.error.message);
        return;
      }

      if (metaEventId) trackPixel("CompleteRegistration", metaEventId);
      setDone({ email: form.email.trim() });
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
    <AuthPanel
      title="Crie sua conta em 2 minutos"
      description="3 dias de teste grátis. Sem cartão de crédito para começar."
    >
      <div onFocusCapture={handleStart} onClickCapture={handleStart}>
        {top ? <div className="mb-6 flex flex-col gap-4">{top}</div> : null}
        <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
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

          <FormSection step={1} title="Sua empresa" id="sec-empresa">
          <Field label="Nome da empresa" htmlFor="companyName" required error={fieldErrors.companyName}>
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={Building2}
                name="companyName"
                autoComplete="organization"
                value={form.companyName}
                onChange={(e) => handleCompanyNameChange(e.target.value)}
                maxLength={120}
                invalid={!!fieldErrors.companyName}
              />
            )}
          </Field>

          <Field
            label="Endereço da empresa"
            htmlFor="slug"
            required
            hint="Vai aparecer como innochat.app/SEU-ENDEREÇO."
            error={fieldErrors.slug}
          >
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={Link2}
                name="slug"
                value={form.slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                maxLength={60}
                invalid={!!fieldErrors.slug}
              />
            )}
          </Field>

          <div className="md:col-span-2 lg:col-span-1 xl:col-span-2">
          <Field label="Segmento (opcional)" htmlFor="segment" hint="Ex.: salão, barbearia, clínica.">
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={Tag}
                name="segment"
                value={form.segment}
                onChange={(e) => setForm((f) => ({ ...f, segment: e.target.value }))}
                maxLength={80}
              />
            )}
          </Field>
          </div>
          </FormSection>

          <FormSection step={2} title="Você" id="sec-voce">
          <Field label="Seu nome" htmlFor="ownerName" required error={fieldErrors.ownerName}>
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={User}
                name="ownerName"
                autoComplete="name"
                value={form.ownerName}
                onChange={(e) => setForm((f) => ({ ...f, ownerName: e.target.value }))}
                maxLength={80}
                invalid={!!fieldErrors.ownerName}
              />
            )}
          </Field>

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
                value={maskCpfCnpj(form.document)}
                onChange={(e) => setForm((f) => ({ ...f, document: normalizeDocumentDigits(e.target.value) }))}
                maxLength={18}
                invalid={!!fieldErrors.document}
              />
            )}
          </Field>

          <Field
            label="Seu WhatsApp"
            htmlFor="phone"
            error={fieldErrors.phone}
            hint={!fieldErrors.phone ? "Opcional. É por onde avisamos sobre o teste e a mensalidade." : undefined}
          >
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={Phone}
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="(84) 99999-8888"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                maxLength={20}
                invalid={!!fieldErrors.phone}
              />
            )}
          </Field>

          <div className="md:col-span-2 lg:col-span-1 xl:col-span-2">
          <Field label="E-mail" htmlFor="email" required error={fieldErrors.email}>
            {(fieldProps) => (
              <AuthInput
                {...fieldProps}
                icon={Mail}
                type="email"
                name="email"
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                invalid={!!fieldErrors.email}
              />
            )}
          </Field>
          </div>
          </FormSection>

          <FormSection step={3} title="Acesso" id="sec-acesso">
            <Field label="Senha" htmlFor="password" required error={fieldErrors.password}>
              {(fieldProps) => (
                <AuthInput
                  {...fieldProps}
                  icon={Lock}
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  invalid={!!fieldErrors.password}
                />
              )}
            </Field>
            <Field label="Confirmar senha" htmlFor="confirmPassword" required error={fieldErrors.confirmPassword}>
              {(fieldProps) => (
                <AuthInput
                  {...fieldProps}
                  icon={Lock}
                  type="password"
                  name="confirmPassword"
                  autoComplete="new-password"
                  value={form.confirmPassword}
                  onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                  invalid={!!fieldErrors.confirmPassword}
                />
              )}
            </Field>
          </FormSection>

          <FormSection step={4} title="Depois do teste" id="sec-cobranca">
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

          <TermsCheckbox
            checked={form.acceptedTerms}
            onChange={(checked) => setForm((f) => ({ ...f, acceptedTerms: checked }))}
            error={fieldErrors.acceptedTerms}
          />

          <div>
            <Button icon={UserPlus} type="submit" size="lg" isLoading={isPending} className={AUTH_SUBMIT_CLASS} loadingText="Criando conta…">
              Criar conta
            </Button>
            <AuthTrust trial />
          </div>
        </form>
      </div>
    </AuthPanel>
  );
}
