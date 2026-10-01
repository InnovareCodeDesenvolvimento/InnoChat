"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Download, RotateCcw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { formatInTimeZone } from "date-fns-tz";
import { cancelSubscriptionAction, reactivateSubscriptionAction, undoCancellationAction } from "@/modules/billing/actions";
import type { BillingSnapshot } from "./assinatura-client";

const REASON_MAX = 500;
const RETENTION_DAYS = 90;

function dateBR(iso: string, timezone: string): string {
  return formatInTimeZone(new Date(iso), timezone, "dd/MM/yyyy");
}

/** Aviso "Cancelamento agendado para DD/MM" + botão de desfazer (só o dono). */
export function CancelamentoAgendadoAviso({ tenantSlug, snapshot, isOwner }: { tenantSlug: string; snapshot: BillingSnapshot; isOwner: boolean }) {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  if (!snapshot.cancelAtPeriodEnd || !snapshot.accessEndsAt) return null;

  function undo() {
    startTransition(async () => {
      const result = await undoCancellationAction(tenantSlug);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível desfazer", description: result.error.message });
        router.refresh();
        return;
      }
      notify({ variant: "success", title: "Cancelamento desfeito.", description: "Sua assinatura segue normalmente." });
      router.refresh();
    });
  }

  const date = dateBR(snapshot.accessEndsAt, snapshot.timezone);
  return (
    <Alert variant="warning" title={`Cancelamento agendado para ${date}`} data-testid="assinatura-cancelamento-agendado">
      <p>
        Você usa tudo normalmente até {date} e não haverá nova cobrança. Depois disso os números de WhatsApp são desconectados e o painel
        mostra só esta tela.
      </p>
      <p className="mt-2">
        A fatura em aberto foi anulada e o Pix que ela tinha foi cancelado: não pague o Pix antigo. Se você desfizer o cancelamento, geramos um
        Pix novo.
      </p>
      {isOwner ? (
        <Button type="button" variant="secondary" size="sm" className="mt-3" icon={RotateCcw} onClick={undo} isLoading={isPending} loadingText="Desfazendo…">
          Desfazer cancelamento
        </Button>
      ) : (
        <p className="mt-2">Só o proprietário da empresa pode desfazer o cancelamento.</p>
      )}
    </Alert>
  );
}

/** Card discreto no fim da página + diálogo de confirmação. Só aparece enquanto não há cancelamento agendado/em vigor. */
export function CancelarAssinaturaCard({ tenantSlug, snapshot, isOwner }: { tenantSlug: string; snapshot: BillingSnapshot; isOwner: boolean }) {
  const { notify } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  if (snapshot.status === "CANCELED" || snapshot.cancelAtPeriodEnd) return null;

  const immediate = snapshot.status === "SUSPENDED" || snapshot.status === "PAST_DUE";
  const endsAt = snapshot.status === "TRIALING" && snapshot.trialEndsAt ? snapshot.trialEndsAt : snapshot.currentPeriodEnd;
  const endsAtLabel = dateBR(endsAt, snapshot.timezone);

  function confirm() {
    startTransition(async () => {
      const result = await cancelSubscriptionAction(tenantSlug, { reason: reason.trim() || undefined });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível cancelar", description: result.error.message });
        return;
      }
      setOpen(false);
      setReason("");
      notify({
        variant: "success",
        title: result.data.mode === "SCHEDULED" ? "Cancelamento agendado." : "Assinatura cancelada.",
        description:
          result.data.mode === "SCHEDULED"
            ? `Você usa tudo até ${dateBR(result.data.endsAt, snapshot.timezone)}. Enviamos a confirmação por e-mail.`
            : "O acesso foi encerrado. Enviamos a confirmação por e-mail.",
      });
      router.refresh();
    });
  }

  return (
    <>
      <Card className="rounded-hero border-dashed">
        <CardHeader help="assinatura.cancelar">
          <CardTitle className="text-base">Cancelar assinatura</CardTitle>
          <CardDescription>
            {immediate
              ? "Encerra a assinatura agora. Como ela não está em dia, não há período pago a aproveitar."
              : `Você continua usando tudo até ${endsAtLabel}, sem nova cobrança. Dá para desfazer até essa data.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isOwner ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="assinatura-cancelar-abrir">
              Cancelar assinatura
            </Button>
          ) : (
            <p className="text-sm text-text-secondary">
              Só o proprietário da empresa pode cancelar a assinatura. Se for o caso, peça a ele. Ao cancelar, o acesso vai até {immediate ? "o mesmo momento" : endsAtLabel}.
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={(next) => !isPending && setOpen(next)}>
        <DialogContent>
          <DialogHeader icon={AlertTriangle} tone="warning">
            <DialogTitle>Cancelar a assinatura?</DialogTitle>
            <DialogDescription>
              {immediate
                ? "O cancelamento vale agora."
                : snapshot.status === "TRIALING"
                  ? `O cancelamento vale no fim do seu teste, em ${endsAtLabel}.`
                  : `O cancelamento vale no fim do período que você já pagou, em ${endsAtLabel}. Esse período não é reembolsado.`}
            </DialogDescription>
          </DialogHeader>

          <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-text-secondary">
            <li>{immediate ? "O painel passa a mostrar só a tela de Assinatura, e os números de WhatsApp são desconectados." : `Até ${endsAtLabel}, tudo continua funcionando e não há nova cobrança.`}</li>
            <li>Depois disso, os números de WhatsApp são desconectados e o bot para de responder. Você poderá reativar quando quiser, pela tela de Assinatura.</li>
            <li>Seus dados ficam guardados por {RETENTION_DAYS} dias. Depois, os dados dos seus clientes são anonimizados.</li>
          </ul>
          {!immediate ? (
            <Link
              href={`/${tenantSlug}/clientes`}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              onClick={() => setOpen(false)}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Exportar meus clientes (CSV) antes de cancelar
            </Link>
          ) : null}

          <div className="mt-4">
            <Field label="Por que você está cancelando? (opcional)" hint="Pode ser uma frase curta. Ajuda a melhorar o InnoChat.">
              {(fieldProps) => (
                <Textarea
                  {...fieldProps}
                  rows={3}
                  maxLength={REASON_MAX}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Ex.: estou fechando o salão"
                />
              )}
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" variant="danger" onClick={confirm} isLoading={isPending} loadingText="Cancelando…" data-testid="assinatura-cancelar-confirmar">
              Cancelar assinatura
            </Button>
            <Button type="button" icon={Check} onClick={() => setOpen(false)} disabled={isPending} autoFocus data-testid="assinatura-cancelar-manter">
              Manter minha assinatura
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Assinatura cancelada: explica o que aconteceu e deixa o dono reativar (gera a fatura/Pix da mensalidade). */
export function AssinaturaCanceladaCard({ tenantSlug, snapshot, isOwner }: { tenantSlug: string; snapshot: BillingSnapshot; isOwner: boolean }) {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function reactivate() {
    startTransition(async () => {
      const result = await reactivateSubscriptionAction(tenantSlug);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível reativar", description: result.error.message });
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="rounded-hero">
      <CardHeader help="assinatura.reativar">
        <CardTitle>Assinatura cancelada</CardTitle>
        <CardDescription>
          Os números de WhatsApp foram desconectados e o painel mostra só esta tela.
          {snapshot.retentionEndsAt && !snapshot.dataAnonymized
            ? ` Seus dados ficam guardados até ${dateBR(snapshot.retentionEndsAt, snapshot.timezone)}; depois, os dados dos seus clientes são anonimizados.`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {snapshot.dataAnonymized ? (
          <Alert variant="warning" title="Os dados dos seus clientes foram anonimizados" className="mb-3" data-testid="assinatura-dados-anonimizados">
            <p>
              Já se passaram {RETENTION_DAYS} dias do cancelamento. Nomes, telefones, anotações e conversas dos seus clientes foram removidos e não
              podem ser recuperados. Ao reativar, você volta com a agenda, o catálogo e as configurações, mas os clientes antigos aparecem sem os dados
              pessoais.
            </p>
          </Alert>
        ) : null}
        {isOwner ? (
          snapshot.invoice ? (
            <p className="text-sm text-text-secondary">
              Pague o Pix abaixo para reativar. Pix de antes do cancelamento foram cancelados: use só o desta fatura. Depois, conecte seu número de
              WhatsApp de novo.
            </p>
          ) : (
            <Button type="button" onClick={reactivate} isLoading={isPending} loadingText="Gerando o Pix…" data-testid="assinatura-reativar">
              Reativar assinatura
            </Button>
          )
        ) : (
          <p className="text-sm text-text-secondary">Só o proprietário da empresa pode reativar a assinatura.</p>
        )}
      </CardContent>
    </Card>
  );
}
