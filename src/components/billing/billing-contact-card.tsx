"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Mail, MessageCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type { HelpKey } from "@/components/help/help-content";
import { formatPhoneDisplay } from "@/components/lib/format-phone";
import { parseBrazilianPhoneToE164 } from "@/core/whatsapp/phone";
import { isPlausibleEmail, type BillingContactData, type SaveBillingContact } from "./billing-contact-types";

const CARD_ID = "contato-de-cobranca";

/**
 * "Contato de cobrança" da tela Assinatura (docs/regua-de-cobranca.md §3.3, decisão D4/D5 do dono):
 * e-mail do financeiro (opcional) e WhatsApp de cobrança, com a chave "Receber cobrança pelo
 * WhatsApp" LIGADA por padrão (desligar = opt-out). OWNER edita; STAFF só vê.
 */
export function BillingContactCard({
  tenantSlug,
  initial,
  canEdit,
  save,
  helpKey = "assinatura.contato",
  description = "Para onde vão os avisos da mensalidade.",
}: {
  tenantSlug: string;
  initial: BillingContactData;
  canEdit: boolean;
  save: SaveBillingContact;
  /** A tela do Admin usa a própria ajuda e o próprio texto. */
  helpKey?: HelpKey;
  description?: string;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const switchLabelId = useId();
  const switchHintId = useId();

  const initialPhoneDisplay = initial.billingWhatsappE164 ? formatPhoneDisplay(initial.billingWhatsappE164) : "";
  const [email, setEmail] = useState(initial.billingEmail ?? "");
  const [phone, setPhone] = useState(initialPhoneDisplay);
  const [receiveWhatsapp, setReceiveWhatsapp] = useState(!initial.optedOut);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // A conferência disse "esse número não tem WhatsApp": oferece salvar mesmo assim (o dono sabe mais que a conferência).
  const [noWhatsapp, setNoWhatsapp] = useState(false);
  // Número salvo, avisos ligados e ainda sem o "SIM": o primeiro aviso pede a confirmação.
  const awaitingConfirmation = !!initial.billingWhatsappE164 && !initial.optedOut && initial.whatsappConfirmed === false;

  // Chegou por "#contato-de-cobranca" (aviso do painel, Configurações): o navegador não rola até aqui sozinho porque a
  // página abre em streaming e o cartão ainda não existia no instante da navegação. Rola e põe o foco no número.
  useEffect(() => {
    if (window.location.hash !== `#${CARD_ID}`) return;
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(CARD_ID);
      if (!card) return;
      card.scrollIntoView({ block: "start" });
      card.querySelector<HTMLInputElement>('input[type="tel"]')?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const dirty =
    email.trim() !== (initial.billingEmail ?? "") ||
    phone.trim() !== initialPhoneDisplay ||
    receiveWhatsapp !== !initial.optedOut;

  function submit(skipWhatsappCheck: boolean) {
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    let valid = true;

    if (trimmedEmail && !isPlausibleEmail(trimmedEmail)) {
      setEmailError("Esse e-mail parece incompleto. Confira e tente de novo.");
      valid = false;
    } else {
      setEmailError(null);
    }

    const e164 = trimmedPhone ? parseBrazilianPhoneToE164(trimmedPhone) : null;
    if (trimmedPhone && !e164) {
      setPhoneError("Digite o WhatsApp com DDD, por exemplo (84) 99999-0000.");
      valid = false;
    } else {
      setPhoneError(null);
    }
    if (!valid) return;

    startTransition(async () => {
      const result = await save(tenantSlug, {
        billingEmail: trimmedEmail || null,
        billingWhatsapp: e164,
        optOut: !receiveWhatsapp,
        ...(skipWhatsappCheck ? { skipWhatsappCheck: true } : {}),
      });
      if (!result.ok) {
        if (result.error.code === "NO_WHATSAPP") {
          setPhoneError(result.error.message);
          setNoWhatsapp(true);
          return;
        }
        notify({ variant: "error", title: "Não foi possível salvar o contato", description: result.error.message });
        return;
      }
      setNoWhatsapp(false);
      notify({ variant: "success", title: "Contato de cobrança salvo." });
      router.refresh();
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(false);
  }

  return (
    <Card className="scroll-mt-24 rounded-hero" id={CARD_ID} data-testid="billing-contact-card">
      <CardHeader help={helpKey}>
        <CardTitle>Contato de cobrança</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      {canEdit ? (
        <form onSubmit={handleSubmit} noValidate>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <Field
              label="E-mail do financeiro (opcional)"
              error={emailError}
              hint={
                initial.ownerEmail
                  ? `Sem e-mail aqui, os avisos vão para ${initial.ownerEmail}.`
                  : "Sem e-mail aqui, os avisos vão para o e-mail do dono."
              }
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="financeiro@suaempresa.com.br"
                  value={email}
                  invalid={!!emailError}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>

            <Field label="WhatsApp de cobrança" error={phoneError} hint={
                awaitingConfirmation && phone.trim() === initialPhoneDisplay
                  ? "Aguardando confirmação: responda SIM à primeira mensagem que chegar para confirmar que o número é seu."
                  : "Com DDD. É nele que chegam os avisos de fatura."
              }
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="(84) 99999-0000"
                  value={phone}
                  invalid={!!phoneError}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setNoWhatsapp(false);
                    setPhoneError(null);
                  }}
                />
              )}
            </Field>

            <div className="flex items-center gap-3 sm:col-span-2">
              <Switch
                checked={receiveWhatsapp}
                onCheckedChange={setReceiveWhatsapp}
                aria-labelledby={switchLabelId}
                aria-describedby={switchHintId}
              />
              <div className="min-w-0">
                <p id={switchLabelId} className="text-sm font-medium text-text">
                  Receber cobrança pelo WhatsApp
                </p>
                <p id={switchHintId} className="text-xs text-text-secondary">
                  {receiveWhatsapp
                    ? "Ligado. Os avisos de fatura chegam no WhatsApp além do e-mail."
                    : "Desligado. Você recebe os avisos só por e-mail e no painel."}
                </p>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" icon={Check} isLoading={isPending} loadingText="Salvando…" disabled={!dirty}>
              Salvar contato
            </Button>
            {noWhatsapp ? (
              <Button type="button" variant="secondary" disabled={isPending} onClick={() => submit(true)}>
                Salvar mesmo assim
              </Button>
            ) : null}
          </CardFooter>
        </form>
      ) : (
        <>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
                <div className="min-w-0">
                  <dt className="text-xs text-text-secondary">E-mail de cobrança</dt>
                  <dd className="truncate text-sm text-text">{initial.billingEmail ?? initial.ownerEmail ?? "E-mail do dono"}</dd>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
                <div className="min-w-0">
                  <dt className="text-xs text-text-secondary">WhatsApp de cobrança</dt>
                  <dd className="text-sm text-text">
                    {initial.billingWhatsappE164 ? formatPhoneDisplay(initial.billingWhatsappE164) : "Não informado"}
                    {initial.billingWhatsappE164 ? (
                      <span className="text-text-secondary">{initial.optedOut ? " (avisos desligados)" : awaitingConfirmation ? " (aguardando confirmação)" : " (avisos ligados)"}</span>
                    ) : null}
                  </dd>
                </div>
              </div>
            </dl>
          </CardContent>
          <CardFooter>
            <p className="text-sm text-text-secondary">Só o dono da empresa pode alterar o contato de cobrança.</p>
          </CardFooter>
        </>
      )}
    </Card>
  );
}
