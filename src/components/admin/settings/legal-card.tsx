"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Scale } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { useToast } from "@/components/ui/toast";
import { maskCpfCnpj } from "@/components/lib/document-mask";
import { normalizeDocumentDigits } from "@/core/billing/document";
import { updatePlatformLegalInfoAction, updatePlatformSalesWhatsappAction } from "@/modules/platform/actions";
import type { PlatformLegalInfo } from "@/core/legal/placeholders";
import type { SalesWhatsapp } from "@/modules/platform/sales-contact";
import { HelpButton } from "@/components/help/help-button";
import { formatBrPhoneDisplay, normalizeBrPhoneToE164 } from "@/core/contact/br-phone";
import { useReportDirty } from "./dirty-forms";

const EMPTY_LEGAL_INFO: PlatformLegalInfo = {
  companyLegalName: null,
  companyCnpj: null,
  companyAddress: null,
  contactEmail: null,
  dpoName: null,
  dpoEmail: null,
  forumCity: null,
  hostingRegion: null,
  backupRetentionDays: null,
};

function toForm(legal: PlatformLegalInfo) {
  return {
    companyLegalName: legal.companyLegalName ?? "",
    companyCnpj: legal.companyCnpj ?? "",
    companyAddress: legal.companyAddress ?? "",
    contactEmail: legal.contactEmail ?? "",
    dpoName: legal.dpoName ?? "",
    dpoEmail: legal.dpoEmail ?? "",
    forumCity: legal.forumCity ?? "",
    hostingRegion: legal.hostingRegion ?? "",
    backupRetentionDays: legal.backupRetentionDays != null ? String(legal.backupRetentionDays) : "",
  };
}

export function LegalCard({ initialLegal, initialSalesWhatsapp }: { initialLegal: PlatformLegalInfo | null; initialSalesWhatsapp: SalesWhatsapp | null }) {
  const router = useRouter();
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [legal, setLegal] = useState<PlatformLegalInfo>(initialLegal ?? EMPTY_LEGAL_INFO);
  const [legalForm, setLegalForm] = useState(() => toForm(initialLegal ?? EMPTY_LEGAL_INFO));
  const [legalError, setLegalError] = useState<string | null>(null);
  const [salesSaved, setSalesSaved] = useState<SalesWhatsapp | null>(initialSalesWhatsapp);
  const [salesPhone, setSalesPhone] = useState(initialSalesWhatsapp?.display ?? "");
  const [salesError, setSalesError] = useState<string | null>(null);

  const saved = toForm(legal);
  useReportDirty("legal", (Object.keys(saved) as Array<keyof typeof saved>).some((k) => legalForm[k] !== saved[k]));
  useReportDirty("sales", salesPhone !== (salesSaved?.display ?? ""));

  function handleSaveLegal(e: React.FormEvent) {
    e.preventDefault();
    setLegalError(null);
    const cnpjDigits = legalForm.companyCnpj ? normalizeDocumentDigits(legalForm.companyCnpj) : "";
    startTransition(async () => {
      const result = await updatePlatformLegalInfoAction({
        companyLegalName: legalForm.companyLegalName,
        companyCnpj: cnpjDigits,
        companyAddress: legalForm.companyAddress,
        contactEmail: legalForm.contactEmail,
        dpoName: legalForm.dpoName,
        dpoEmail: legalForm.dpoEmail,
        forumCity: legalForm.forumCity,
        hostingRegion: legalForm.hostingRegion,
        backupRetentionDays: legalForm.backupRetentionDays ? Number(legalForm.backupRetentionDays) : null,
      });
      if (!result.ok) {
        setLegalError(result.error.message);
        return;
      }
      setLegal(result.data);
      setLegalForm(toForm(result.data));
      notify({ variant: "success", title: "Dados da empresa salvos." });
      router.refresh();
    });
  }

  function handleSaveSales(e: React.FormEvent) {
    e.preventDefault();
    setSalesError(null);
    startTransition(async () => {
      const result = await updatePlatformSalesWhatsappAction({ phone: salesPhone });
      if (!result.ok) {
        setSalesError(result.error.message);
        return;
      }
      setSalesSaved(result.data);
      setSalesPhone(result.data?.display ?? "");
      notify({
        variant: "success",
        title: result.data ? "WhatsApp comercial salvo." : "WhatsApp comercial removido; o botão sumiu do site.",
      });
    });
  }

  return (
    <Card id="dados-empresa" className="rounded-hero">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-text-secondary" aria-hidden="true" />
          <CardTitle>Dados da empresa (Termos e Privacidade)</CardTitle>
        </div>
        <CardDescription>
          Preenche os marcadores como <code className="text-xs">[CNPJ]</code>/<code className="text-xs">[ENDEREÇO]</code> nas
          páginas públicas <code className="text-xs">/termos</code> e <code className="text-xs">/privacidade</code>. Nenhum
          destes dados é segredo. Deixar um campo vazio limpa o dado e volta a mostrar &ldquo;a definir&rdquo; nas páginas
          públicas.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSaveLegal}>
        <CardContent className="flex flex-col gap-4">
          {legalError ? <Alert variant="danger">{legalError}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Razão social">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={legalForm.companyLegalName}
                  onChange={(e) => setLegalForm((f) => ({ ...f, companyLegalName: e.target.value }))}
                  placeholder="Innovare Code Tecnologia Ltda."
                />
              )}
            </Field>
            <Field label="CNPJ">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  inputMode="numeric"
                  autoComplete="off"
                  value={maskCpfCnpj(legalForm.companyCnpj)}
                  onChange={(e) => setLegalForm((f) => ({ ...f, companyCnpj: normalizeDocumentDigits(e.target.value) }))}
                  maxLength={18}
                  placeholder="00.000.000/0000-00"
                />
              )}
            </Field>
          </div>
          <Field label="Endereço">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={legalForm.companyAddress}
                onChange={(e) => setLegalForm((f) => ({ ...f, companyAddress: e.target.value }))}
                placeholder="Rua Exemplo, 123, Bairro, Cidade/UF, CEP 00000-000"
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="E-mail de contato">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="email"
                  value={legalForm.contactEmail}
                  onChange={(e) => setLegalForm((f) => ({ ...f, contactEmail: e.target.value }))}
                  placeholder="contato@innovarecode.com.br"
                />
              )}
            </Field>
            <Field label="Comarca (foro)">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={legalForm.forumCity}
                  onChange={(e) => setLegalForm((f) => ({ ...f, forumCity: e.target.value }))}
                  placeholder="São Paulo/SP"
                />
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome do encarregado (DPO)">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={legalForm.dpoName}
                  onChange={(e) => setLegalForm((f) => ({ ...f, dpoName: e.target.value }))}
                />
              )}
            </Field>
            <Field label="E-mail do encarregado (DPO)">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="email"
                  value={legalForm.dpoEmail}
                  onChange={(e) => setLegalForm((f) => ({ ...f, dpoEmail: e.target.value }))}
                  placeholder="dpo@innovarecode.com.br"
                />
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="País/região da hospedagem">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={legalForm.hostingRegion}
                  onChange={(e) => setLegalForm((f) => ({ ...f, hostingRegion: e.target.value }))}
                  placeholder="Brasil"
                />
              )}
            </Field>
            <Field label="Prazo de retenção dos backups (dias)">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="number"
                  min={1}
                  max={3650}
                  value={legalForm.backupRetentionDays}
                  onChange={(e) => setLegalForm((f) => ({ ...f, backupRetentionDays: e.target.value }))}
                  placeholder="30"
                />
              )}
            </Field>
          </div>
        </CardContent>
        <CardFooter>
          <Button icon={Check} type="submit" isLoading={isPending} loadingText="Salvando…">
            Salvar
          </Button>
        </CardFooter>
      </form>

      <form onSubmit={handleSaveSales} className="border-t border-border">
        <CardContent className="flex flex-col gap-4 pt-6">
          {salesError ? <Alert variant="danger">{salesError}</Alert> : null}
          <Field
            label="WhatsApp de atendimento comercial (botão 'Tirar dúvidas' do site)"
            labelAction={<HelpButton helpKey="admin.whatsappComercial" />}
            hint={
              salesSaved
                ? `Salvo: ${salesSaved.display}. O botão aparece no site.`
                : "Com DDD, com ou sem máscara. Vazio = o botão 'Tirar dúvidas' não aparece no site."
            }
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={salesPhone}
                onChange={(e) => setSalesPhone(e.target.value)}
                onBlur={() => {
                  const e164 = normalizeBrPhoneToE164(salesPhone);
                  if (e164) setSalesPhone(formatBrPhoneDisplay(e164));
                }}
                maxLength={40}
                placeholder="(84) 3113-2584"
              />
            )}
          </Field>
        </CardContent>
        <CardFooter>
          <Button icon={Check} type="submit" isLoading={isPending} loadingText="Salvando…">
            Salvar WhatsApp
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
